package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func TestRedactRemoves(t *testing.T) {
	for name, tc := range map[string]struct{ in, leak string }{
		"domain":          {"dial tcp: lookup api.acme-corp.io: no such host", "acme-corp.io"},
		"subdomain":       {"certificate for portainer.my-server.example.org expired", "my-server"},
		"ipv4":            {"connect to 203.0.113.45:6443 refused", "203.0.113.45"},
		"ipv4 cidr":       {"PLATFORM_CLUSTER_NODES=10.0.0.0/24 invalid", "10.0.0.0"},
		"ipv6":            {"listen on [2001:db8::1]:443 failed", "2001:db8"},
		"ipv6 full":       {"node fe80:0:0:0:204:61ff:fe9d:f156 unreachable", "fe9d"},
		"email":           {"ACME account admin@acme-corp.io rejected", "admin@"},
		"url":             {"GET https://registry.acme.io/v2/x?token=abc failed", "registry.acme.io"},
		"url with creds":  {"remote s3://AKIDEXAMPLE:verysecret@bucket/x", "verysecret"},
		"jwt":             {"Authorization header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGci"},
		"bearer":          {"sent Bearer abcdefghijklmnop123 to server", "abcdefghijklmnop123"},
		"auth header":     {"authorization: basic dXNlcjpwYXNz", "dXNlcjpwYXNz"},
		"agent token":     {"token plat_agent_0123456789abcdef rejected", "0123456789abcdef"},
		"sdk key":         {"key sdk_live_AbCdEfGh12345678 invalid", "AbCdEfGh12345678"},
		"license key":     {"activate cairn_0123456789abcdef_SECRETpart failed", "SECRETpart"},
		"github token":    {"ghp_1234567890abcdefghijklmnopqrstuvwxyz used", "ghp_1234567890"},
		"aws key":         {"AKIAIOSFODNN7EXAMPLE denied", "AKIAIOSFODNN7EXAMPLE"},
		"age key":         {"AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQS", "QYQSZQGP"},
		"password env":    {"ADMIN_PASSWORD=hunter2hunter2 not accepted", "hunter2"},
		"password json":   {`{"password": "s3cr3t-value"}`, "s3cr3t-value"},
		"secret yaml":     {"minio_secret_key: Zx9-supersecret", "Zx9-supersecret"},
		"quoted token":    {`GITHUB_TOKEN='abc def ghi'`, "abc def ghi"},
		"private key":     {"-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA"},
		"random token":    {"value 9f8e7d6c5b4a39281706f5e4d3c2b1a0Zq9x stored", "9f8e7d6c5b4a39281706"},
		"base64 blob":     {"data QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA= end", "QWxhZGRpbjpvcGVu"},
		"uppercase email": {"User JOHN.DOE@EXAMPLE.COM blocked", "JOHN.DOE"},
	} {
		got := Redact(tc.in)
		if strings.Contains(got, tc.leak) {
			t.Errorf("%s: %q leaks %q -> %q", name, tc.in, tc.leak, got)
		}
	}
}

func TestRedactKeepsUsefulText(t *testing.T) {
	for _, in := range []string{
		"helm upgrade postgresql failed: context deadline exceeded",
		"install oauth2-proxy timed out after 5m0s",
		"read /etc/platform/.env: permission denied",
		"apply values.yaml and k3s.yaml",
		"exec.Command returned exit status 1",
		"ingress-nginx-controller-admission webhook not ready",
		"k3s v1.37.2+k3s1 on Ubuntu 24.04.1 LTS",
		"step took 12:30:45",
		"2 tokens remaining",
	} {
		if got := Redact(in); got != in {
			t.Errorf("Redact(%q) = %q", in, got)
		}
	}
}

func TestRedactedPayloadCapsErrors(t *testing.T) {
	long := strings.Repeat("e", 1000) + " admin@acme.io"
	p := Payload{
		Kind: KindError, OS: "Ubuntu 24.04 LTS", Kubernetes: "v1.37.2+k3s1",
		Steps:      []Step{{Step: "k3s", Seconds: 1, Status: "ok"}},
		Failures:   []Failure{{Step: "routing", Error: "lookup portal.acme.io: " + long}},
		Components: []Component{{Name: "Platform API", Status: "ok"}},
	}
	r := p.Redacted()
	if n := len([]rune(r.Failures[0].Error)); n != MaxErrorLen {
		t.Fatalf("error length %d", n)
	}
	if strings.Contains(r.Failures[0].Error, "acme") {
		t.Fatalf("leak: %s", r.Failures[0].Error)
	}
	if p.Failures[0].Error == r.Failures[0].Error {
		t.Fatal("input mutated or not redacted")
	}
	if Truncate("héllo", 2) != "hé" {
		t.Fatal("truncate is not rune-safe")
	}
}

func TestEnabled(t *testing.T) {
	for v, want := range map[string]bool{"": true, "on": true, "true": true, "off": false, "OFF": false, "false": false, "no": false, "0": false} {
		if Enabled(v) != want {
			t.Errorf("Enabled(%q) != %v", v, want)
		}
	}
}

func TestStepsAndFailures(t *testing.T) {
	ts := []state.StepTiming{
		{Step: "k3s", Duration: 1234 * time.Millisecond, Status: "ok"},
		{Step: "routing", Duration: time.Second, Status: "failed"},
	}
	steps := StepsFrom(ts)
	if len(steps) != 2 || steps[0].Seconds != 1.2 || steps[1].Status != "failed" {
		t.Fatalf("steps %+v", steps)
	}
	f := FailuresFrom(ts, "provision", errors.New("routing failed"))
	if len(f) != 2 || f[0].Step != "routing" || f[1].Error != "routing failed" {
		t.Fatalf("failures %+v", f)
	}
	if got := FailuresFrom(nil, "update", nil); got == nil || len(got) != 0 {
		t.Fatalf("empty failures %#v", got)
	}
}

func TestHostFiles(t *testing.T) {
	dir := t.TempDir()
	osr := filepath.Join(dir, "os-release")
	os.WriteFile(osr, []byte("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n"), 0o644)
	if got := OSRelease(osr); got != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("os %q", got)
	}
	up := filepath.Join(dir, "uptime")
	os.WriteFile(up, []byte("3600.52 7000.1\n"), 0o644)
	if Uptime(up) != 3600 || Uptime(filepath.Join(dir, "missing")) != 0 {
		t.Fatal("uptime")
	}
}

func TestSendWritesRedactedPrivateFileAndRemovesIt(t *testing.T) {
	var path string
	var body []byte
	err := Send(context.Background(), Payload{Kind: KindProvision, Failures: []Failure{{Step: "x", Error: "token=abc123secret"}}},
		func(ctx context.Context, file string) error {
			if _, ok := ctx.Deadline(); !ok {
				t.Error("no timeout")
			}
			path = file
			if fi, err := os.Stat(file); err == nil && runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
				t.Errorf("mode %v", fi.Mode())
			}
			body, _ = os.ReadFile(file)
			return nil
		})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("temp file not removed")
	}
	var p Payload
	if err := json.Unmarshal(body, &p); err != nil || p.Kind != KindProvision || strings.Contains(string(body), "abc123secret") {
		t.Fatalf("payload %s %v", body, err)
	}
	for _, key := range []string{`"kind"`, `"version"`, `"profile"`, `"nodes"`, `"arch"`, `"os"`, `"kubernetes"`, `"uptime_seconds"`, `"steps"`, `"failures"`, `"components"`} {
		if !strings.Contains(string(body), key) {
			t.Errorf("missing %s", key)
		}
	}
}
