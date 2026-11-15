package backup

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Compatibility with configurations written before #195, when platformctl
// shelled out to the MinIO client. Such a backup.json can still contain
//
//   - "target": "s3://<mc alias>/<bucket>/<prefix>" (an alias the operator
//     created with `mc alias set`), or
//   - "minioAlias": "<mc alias>" (a non-bundled MinIO as the file source).
//
// mc kept the alias credentials in its own config (~/.mc/config.json, or
// $MC_CONFIG_DIR/config.json) or in an MC_HOST_<alias> variable. platformctl
// now reads that config itself, so these setups keep working without the mc
// binary. When the alias cannot be found, the error names the command that
// replaces it.

// legacyAliasHint is the one-line fix printed when an mc alias is unusable.
const legacyAliasHint = "configure the off-site target with `sudo platformctl backup target set --endpoint <url> --bucket <bucket> [--region <region>] [--prefix <prefix>]` and set \"target\": \"external\" in /etc/platform/backup.json (see docs/operations/upgrades.md)"

// mcConfigPaths lists where mc kept its aliases, in mc's own order of
// precedence, plus root's home for the nightly job (nsenter keeps the pod's
// environment, which may not point HOME at /root).
var mcConfigPaths = func() []string {
	var out []string
	if d := os.Getenv("MC_CONFIG_DIR"); d != "" {
		out = append(out, filepath.Join(d, "config.json"))
	}
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		out = append(out, filepath.Join(h, ".mc", "config.json"))
	}
	return append(out, "/root/.mc/config.json")
}

// mcConfig is the subset of mc's config.json (version 10 uses "aliases",
// older versions "hosts") that platformctl needs.
type mcConfig struct {
	Aliases map[string]mcAlias `json:"aliases"`
	Hosts   map[string]mcAlias `json:"hosts"`
}

type mcAlias struct {
	URL       string `json:"url"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

var awsRegionHost = regexp.MustCompile(`^s3[.-]([a-z0-9-]+)\.amazonaws\.com$`)

// legacyAliasTarget returns the endpoint and credentials of an mc alias, with
// bucket filled in. The credentials stay in memory only.
func legacyAliasTarget(alias, bucket string) (S3Target, error) {
	a, err := lookupMCAlias(alias)
	if err != nil {
		return S3Target{}, err
	}
	u, err := url.Parse(strings.TrimSpace(a.URL))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || (u.Path != "" && u.Path != "/") {
		return S3Target{}, fmt.Errorf("the mc alias %q has an unusable URL; %s", alias, legacyAliasHint)
	}
	t := S3Target{Endpoint: u.Scheme + "://" + u.Host, Bucket: bucket, AccessKey: a.AccessKey, SecretKey: a.SecretKey}
	// mc does not store a region. AWS endpoints carry it in the host name;
	// other stores (MinIO, R2, B2 path-style) accept the default.
	if m := awsRegionHost.FindStringSubmatch(u.Hostname()); m != nil {
		t.Region = m[1]
	}
	t = t.Normalize()
	if bucket != "" {
		if err := t.Validate(); err != nil {
			return S3Target{}, fmt.Errorf("the mc alias %q is not usable (%v); %s", alias, err, legacyAliasHint)
		}
	} else if t.AccessKey == "" || t.SecretKey == "" {
		return S3Target{}, fmt.Errorf("the mc alias %q has no credentials; %s", alias, legacyAliasHint)
	}
	return t, nil
}

func lookupMCAlias(alias string) (mcAlias, error) {
	if !safeName.MatchString(alias) {
		return mcAlias{}, fmt.Errorf("invalid mc alias name")
	}
	// MC_HOST_<alias>=https://ACCESS:SECRET@host[:port] takes precedence in mc.
	if v := os.Getenv("MC_HOST_" + alias); v != "" {
		u, err := url.Parse(v)
		if err != nil || u.User == nil {
			return mcAlias{}, fmt.Errorf("MC_HOST_%s is not a valid mc host URL; %s", alias, legacyAliasHint)
		}
		secret, _ := u.User.Password()
		access := u.User.Username()
		u.User = nil
		return mcAlias{URL: u.String(), AccessKey: access, SecretKey: secret}, nil
	}
	var tried []string
	for _, p := range mcConfigPaths() {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		tried = append(tried, p)
		var cfg mcConfig
		if err := json.Unmarshal(b, &cfg); err != nil {
			continue
		}
		if a, ok := cfg.Aliases[alias]; ok {
			return a, nil
		}
		if a, ok := cfg.Hosts[alias]; ok {
			return a, nil
		}
	}
	where := "no mc config file was found"
	if len(tried) > 0 {
		where = "it is not in " + strings.Join(tried, ", ")
	}
	return mcAlias{}, fmt.Errorf("backup.json uses the mc alias %q, but %s; %s", alias, where, legacyAliasHint)
}
