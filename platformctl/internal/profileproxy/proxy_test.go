package profileproxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// parseLabelSet mirrors the receiver's parser (pyroscope api/model/labelset
// Parse, used by Alloy's pyroscope.receive_http /ingest): the labels the
// collector will see for a given name parameter.
func parseLabelSet(name string) map[string]string {
	const (
		stName = iota
		stKey
		stValue
		stDone
	)
	out := map[string]string{}
	state := stName
	var key, value strings.Builder
	for _, r := range name + "{" {
		switch state {
		case stName:
			if r == '{' {
				state = stKey
				out["__name__"] = strings.TrimSpace(value.String())
			} else {
				value.WriteRune(r)
			}
		case stKey:
			switch r {
			case '}':
				state = stDone
			case '=':
				state = stValue
				value.Reset()
			default:
				key.WriteRune(r)
			}
		case stValue:
			switch r {
			case ',', '}':
				state = stKey
				out[strings.TrimSpace(key.String())] = strings.TrimSpace(value.String())
				key.Reset()
			default:
				value.WriteRune(r)
			}
		}
	}
	return out
}

type captured struct {
	n      int
	query  url.Values
	header http.Header
	body   string
	path   string
}

func newProxy(t *testing.T) (*httptest.Server, *captured) {
	t.Helper()
	c := &captured{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.n++
		c.query, c.header, c.path = r.URL.Query(), r.Header.Clone(), r.URL.Path
		b, _ := io.ReadAll(r.Body)
		c.body = string(b)
	}))
	t.Cleanup(up.Close)
	u, _ := url.Parse(up.URL)
	srv := httptest.NewServer(Handler(u, nil))
	t.Cleanup(srv.Close)
	return srv, c
}

func post(t *testing.T, srv *httptest.Server, path string, hdr map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader("profile-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "multipart/form-data; boundary=x")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

var authA = map[string]string{HeaderProject: "proj-a", HeaderEnvironment: "production", "Authorization": "Bearer secret-token"}

func TestClientLabelsForOtherProjectAreStoredAsAuthenticatedProject(t *testing.T) {
	srv, c := newProxy(t)
	name := "proj-b/checkout{platform_project_id=proj-b,deployment_environment=staging,service_name=proj-b/checkout,app_name=x,__tenant=b,region=eu,bad key=1}"
	q := url.Values{"name": {name}, "from": {"1"}, "until": {"2"}, "format": {"pprof"}, "spyName": {"nodespy"}, "evil": {"1"}}
	resp := post(t, srv, "/ingest?"+q.Encode(), authA)
	if resp.StatusCode != 200 || c.n != 1 {
		t.Fatalf("status %d upstream calls %d", resp.StatusCode, c.n)
	}
	got := parseLabelSet(c.query.Get("name"))
	want := map[string]string{
		"__name__":               "proj-a/proj-b/checkout",
		"service_name":           "proj-a/proj-b/checkout",
		"platform_service":       "proj-b/checkout",
		"platform_project_id":    "proj-a",
		"deployment_environment": "production",
		"region":                 "eu",
	}
	if len(got) != len(want) {
		t.Fatalf("labels %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("label %s=%q, want %q (all: %v)", k, got[k], v, got)
		}
	}
	if c.path != "/ingest" || c.query.Get("from") != "1" || c.query.Get("format") != "pprof" || c.query.Has("evil") {
		t.Fatalf("query/path not rewritten: %s %v", c.path, c.query)
	}
	for _, h := range []string{"Authorization", HeaderProject, HeaderEnvironment} {
		if c.header.Get(h) != "" {
			t.Fatalf("%s forwarded upstream", h)
		}
	}
	if c.header.Get("Content-Type") != "multipart/form-data; boundary=x" || c.body != "profile-bytes" {
		t.Fatalf("body/content type not forwarded: %q %q", c.header.Get("Content-Type"), c.body)
	}
}

func TestServiceNamePrefixIsIdempotent(t *testing.T) {
	id := Identity{Project: "proj-a", Environment: "dev"}
	for _, in := range []string{"api", "api{}", "proj-a/api", " api { } "} {
		got, err := RewriteName(in, id)
		if err != nil {
			t.Fatal(in, err)
		}
		if l := parseLabelSet(got); l["__name__"] != "proj-a/api" || l["service_name"] != "proj-a/api" || l["platform_service"] != "api" || l["platform_project_id"] != "proj-a" || l["deployment_environment"] != "dev" {
			t.Fatalf("%q -> %q", in, got)
		}
	}
}

func TestRejectsRequestsWithoutIdentity(t *testing.T) {
	srv, c := newProxy(t)
	q := "/ingest?name=" + url.QueryEscape("app{platform_project_id=proj-b}")
	for _, hdr := range []map[string]string{
		{},
		{HeaderProject: "proj-a"},
		{HeaderEnvironment: "production"},
		{HeaderProject: "", HeaderEnvironment: "production"},
		{HeaderProject: "proj-a,proj-b", HeaderEnvironment: "production"},
		{HeaderProject: "proj a", HeaderEnvironment: "production"},
		{HeaderProject: "proj-a", HeaderEnvironment: "prod}"},
	} {
		if resp := post(t, srv, q, hdr); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%v: status %d", hdr, resp.StatusCode)
		}
	}
	// Duplicate identity headers are ambiguous: reject.
	req, _ := http.NewRequest(http.MethodPost, srv.URL+q, strings.NewReader("x"))
	req.Header.Add(HeaderProject, "proj-a")
	req.Header.Add(HeaderProject, "proj-b")
	req.Header.Set(HeaderEnvironment, "production")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("duplicate headers: %d", resp.StatusCode)
	}
	if c.n != 0 {
		t.Fatalf("unauthenticated request reached upstream %d times", c.n)
	}
}

func TestRejectsOtherEndpointsAndBadInput(t *testing.T) {
	srv, c := newProxy(t)
	for path, want := range map[string]int{
		"/push.v1.PusherService/Push":                     http.StatusNotFound,
		"/debuginfo.v1alpha1.DebuginfoService/Upload/abc": http.StatusNotFound,
		"/ingest/../push":                                 http.StatusNotFound,
		"/ingest":                                         http.StatusBadRequest, // no name
		"/ingest?name=":                                   http.StatusBadRequest,
		"/ingest?name=a%20b":                              http.StatusBadRequest,
		"/ingest?name=app%7Ba=1":                          http.StatusBadRequest, // unterminated label set
		"/ingest?name=a&name=b":                           http.StatusBadRequest,
	} {
		if resp := post(t, srv, path, authA); resp.StatusCode != want {
			t.Fatalf("%s: status %d, want %d", path, resp.StatusCode, want)
		}
	}
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/ingest?name=app", nil)
	req.Header.Set(HeaderProject, "proj-a")
	req.Header.Set(HeaderEnvironment, "production")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", resp.StatusCode)
	}
	if c.n != 0 {
		t.Fatalf("rejected request reached upstream %d times", c.n)
	}
}

func TestLabelValuesCannotInjectLabels(t *testing.T) {
	id := Identity{Project: "proj-a", Environment: "production"}
	got, err := RewriteName("app{region=eu}x,platform_project_id=proj-b}", id)
	if err != nil {
		// Rejecting is also acceptable; storing proj-b is not.
		return
	}
	if l := parseLabelSet(got); l["platform_project_id"] != "proj-a" {
		t.Fatalf("%q -> %v", got, l)
	}
	many := "app{"
	for i := 0; i < 100; i++ {
		many += "k" + strings.Repeat("x", i%5) + string(rune('a'+i%26)) + "=v,"
	}
	got, err = RewriteName(strings.TrimSuffix(many, ",")+"}", id)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(parseLabelSet(got)); n > maxLabels+5 { // + __name__ and four proxy-owned labels
		t.Fatalf("label count unbounded: %d", n)
	}
}

func TestOversizedBodyRejected(t *testing.T) {
	srv, c := newProxy(t)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/ingest?name=app", strings.NewReader(strings.Repeat("x", MaxBodyBytes+1)))
	req.Header.Set(HeaderProject, "proj-a")
	req.Header.Set(HeaderEnvironment, "production")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge || c.n != 0 {
		t.Fatalf("status %d upstream %d", resp.StatusCode, c.n)
	}
}

func TestIdentityLabelSpellingVariantsAreDropped(t *testing.T) {
	id := Identity{Project: "proj-a", Environment: "production"}
	variants := []string{
		"platform.project_id", "Platform_Project_Id", "PLATFORM_PROJECT_ID", "platform-project-id",
		"deployment.environment", "Deployment_Environment", "service.name", "Service_Name",
		"platform.service", "app.name", "__name__", "_.tenant",
	}
	for _, k := range variants {
		got, err := RewriteName("api{"+k+"=proj-b,"+k+"=proj-b,team=x}", id)
		if err != nil {
			t.Fatalf("%s: %v", k, err)
		}
		l := parseLabelSet(got)
		if _, kept := l[k]; kept && k != "__name__" {
			t.Fatalf("%s kept: %q", k, got)
		}
		if l["platform_project_id"] != "proj-a" || l["deployment_environment"] != "production" || l["service_name"] != "proj-a/api" || l["team"] != "x" {
			t.Fatalf("%s: %q", k, got)
		}
		for name, v := range l {
			if v == "proj-b" {
				t.Fatalf("%s: other project value stored under %s: %q", k, name, got)
			}
		}
	}
}

func TestOnlyFormatsWithoutSideLabelsAreForwarded(t *testing.T) {
	srv, c := newProxy(t)
	for _, f := range []string{"jfr", "JFR", "speedscope", "otlp", "pprof,jfr"} {
		if resp := post(t, srv, "/ingest?name=app&format="+url.QueryEscape(f), authA); resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("format %q: status %d", f, resp.StatusCode)
		}
	}
	if resp := post(t, srv, "/ingest?name=app&format=jfr&format=pprof", authA); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("duplicate format: status %d", resp.StatusCode)
	}
	if c.n != 0 {
		t.Fatalf("refused format reached upstream %d times", c.n)
	}
	for _, f := range []string{"pprof", "folded", "lines", "trie", "tree"} {
		if resp := post(t, srv, "/ingest?name=app&format="+f, authA); resp.StatusCode != 200 || c.query.Get("format") != f {
			t.Fatalf("format %q: status %d, upstream %v", f, resp.StatusCode, c.query)
		}
	}
	if resp := post(t, srv, "/ingest?name=app", authA); resp.StatusCode != 200 || c.query.Has("format") {
		t.Fatalf("no format: status %d, upstream %v", resp.StatusCode, c.query)
	}
}
