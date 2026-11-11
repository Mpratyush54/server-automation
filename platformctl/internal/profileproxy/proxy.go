// Package profileproxy sits between the otel.<DOMAIN> ingress and the
// collector's Pyroscope receiver. It sets the profile identity labels
// (project, environment, service name) from the authenticated collector
// identity that ingress-nginx external auth attaches to every request, and
// removes any client-supplied values for those labels.
//
// Only the Pyroscope `/ingest` API is accepted: its series labels travel in the
// `name` query parameter, which this package rewrites. Series labels take
// precedence over pprof sample labels in Pyroscope, so the identity labels set
// here are authoritative for the stored series.
package profileproxy

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// Headers set by ingress-nginx from the ingest-auth response
	// (auth-response-headers). ingress-nginx overwrites client values.
	HeaderProject     = "X-Platform-Project-Id"
	HeaderEnvironment = "X-Platform-Environment"

	LabelProject     = "platform_project_id"
	LabelEnvironment = "deployment_environment"
	LabelService     = "service_name"
	// LabelServiceBase keeps the client's service name without the project
	// prefix (Grafana trace-to-profile links match it with service.name).
	LabelServiceBase = "platform_service"

	// MaxBodyBytes is slightly above the ingress proxy-body-size (4 MiB).
	MaxBodyBytes = 5 << 20
	maxLabels    = 32
	maxValueLen  = 256
	maxNameLen   = 200
)

// Labels the proxy owns: client values are always discarded.
var reservedLabels = map[string]bool{
	LabelProject:     true,
	LabelEnvironment: true,
	LabelService:     true,
	LabelServiceBase: true,
	"app_name":       true,
}

// Query parameters of the Pyroscope /ingest API that are passed through
// (`format` is checked separately against allowedFormats).
var allowedParams = []string{"from", "until", "sampleRate", "spyName", "units", "aggregationType"}

// Upload formats whose series labels come only from `name` (pprof sample
// labels are subordinate to series labels in Pyroscope). Formats that carry
// their own label sets beside the profile (jfr) are refused; empty means the
// receiver infers the format from the content type.
var allowedFormats = map[string]bool{"": true, "pprof": true, "folded": true, "lines": true, "trie": true, "tree": true}

var identityRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// Identity is the authenticated collector identity of one request.
type Identity struct {
	Project     string
	Environment string
}

// ErrUnauthenticated means the request did not carry a valid identity.
var ErrUnauthenticated = errors.New("missing or invalid collector identity")

// IdentityFromHeaders reads the identity set by ingress external auth.
func IdentityFromHeaders(h http.Header) (Identity, error) {
	p, e := h.Values(HeaderProject), h.Values(HeaderEnvironment)
	if len(p) != 1 || len(e) != 1 || !identityRe.MatchString(p[0]) || !identityRe.MatchString(e[0]) {
		return Identity{}, ErrUnauthenticated
	}
	return Identity{Project: p[0], Environment: e[0]}, nil
}

// canonicalLabel folds case and the separators backends normalise ('.', '-')
// so that spelling variants of an identity label are recognised as reserved.
func canonicalLabel(k string) string {
	return strings.Map(func(r rune) rune {
		if r == '.' || r == '-' {
			return '_'
		}
		return r
	}, strings.ToLower(k))
}

func reservedLabel(k string) bool {
	c := canonicalLabel(k)
	return reservedLabels[c] || strings.HasPrefix(c, "__")
}

func labelNameOK(k string) bool {
	if k == "" || len(k) > 100 || strings.HasPrefix(k, "__") {
		return false
	}
	for _, r := range k {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func serviceNameOK(n string) bool {
	if n == "" || len(n) > maxNameLen {
		return false
	}
	for _, r := range n {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '.' || r == '-' || r == '/') {
			return false
		}
	}
	return true
}

func labelValueOK(v string) bool {
	if v == "" || len(v) > maxValueLen {
		return false
	}
	for _, r := range v {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(",{}=", r) {
			return false
		}
	}
	return true
}

// RewriteName returns the Pyroscope `name` parameter (`service{k=v,...}`) for
// the given identity. The service name is prefixed with the project so it
// cannot collide with another project's services; identity labels are always
// set from id; other valid client labels are kept, invalid ones dropped.
func RewriteName(name string, id Identity) (string, error) {
	svc, rest, hasLabels := strings.Cut(name, "{")
	svc = strings.TrimSpace(svc)
	if !serviceNameOK(svc) {
		return "", fmt.Errorf("invalid service name")
	}
	base := strings.TrimPrefix(svc, id.Project+"/")
	if base == "" || len(base) > maxValueLen {
		return "", fmt.Errorf("invalid service name")
	}
	svc = id.Project + "/" + base
	if len(svc) > maxNameLen {
		return "", fmt.Errorf("service name too long")
	}
	out := map[string]string{}
	if hasLabels {
		inner, ok := strings.CutSuffix(strings.TrimSpace(rest), "}")
		if !ok {
			return "", fmt.Errorf("invalid label set")
		}
		for _, pair := range strings.Split(inner, ",") {
			k, v, ok := strings.Cut(pair, "=")
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			if !ok || reservedLabel(k) || !labelNameOK(k) || !labelValueOK(v) || len(out) >= maxLabels {
				continue
			}
			out[k] = v
		}
	}
	out[LabelService] = svc
	out[LabelServiceBase] = base
	out[LabelProject] = id.Project
	out[LabelEnvironment] = id.Environment
	keys := make([]string, 0, len(out))
	for k := range out {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(svc)
	b.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(out[k])
	}
	b.WriteByte('}')
	return b.String(), nil
}

// RewriteQuery returns the upstream query string: a rewritten `name` plus the
// allowed /ingest parameters. Unknown parameters are dropped.
func RewriteQuery(q url.Values, id Identity) (string, error) {
	names := q["name"]
	if len(names) != 1 {
		return "", fmt.Errorf("exactly one name parameter is required")
	}
	name, err := RewriteName(names[0], id)
	if err != nil {
		return "", err
	}
	out := url.Values{"name": {name}}
	if f, ok := q["format"]; ok {
		if len(f) != 1 || !allowedFormats[f[0]] {
			return "", fmt.Errorf("unsupported format")
		}
		if f[0] != "" {
			out.Set("format", f[0])
		}
	}
	for _, p := range allowedParams {
		if v, ok := q[p]; ok && len(v) == 1 {
			out.Set(p, v[0])
		}
	}
	return out.Encode(), nil
}

// Handler proxies authenticated POST /ingest requests to upstream (the
// collector's Pyroscope receiver) with rewritten labels.
func Handler(upstream *url.URL, logger *log.Logger) http.Handler {
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(upstream)
			pr.Out.Host = upstream.Host
		},
		Transport: &http.Transport{
			Proxy:                 nil,
			MaxIdleConnsPerHost:   16,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			if logger != nil {
				logger.Printf("upstream error: %v", err)
			}
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ingest" {
			http.Error(w, "only /ingest is supported", http.StatusNotFound)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id, err := IdentityFromHeaders(r.Header)
		if err != nil {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		query, err := RewriteQuery(r.URL.Query(), id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if r.ContentLength > MaxBodyBytes {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		out := r.Clone(r.Context())
		out.URL = &url.URL{Path: "/ingest", RawQuery: query}
		out.RequestURI = ""
		// Forward only what the receiver reads; never credentials or identity headers.
		out.Header = http.Header{}
		if ct := r.Header.Get("Content-Type"); ct != "" {
			out.Header.Set("Content-Type", ct)
		}
		out.Header.Set("User-Agent", "platform-profile-ingest")
		out.Body = http.MaxBytesReader(w, r.Body, MaxBodyBytes)
		rp.ServeHTTP(w, out)
	})
}
