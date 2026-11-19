package diagnostics

import (
	"strings"
	"testing"
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
