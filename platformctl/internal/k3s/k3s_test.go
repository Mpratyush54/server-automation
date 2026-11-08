package k3s

import (
	"strings"
	"testing"
)

func TestRegistriesYAML(t *testing.T) {
	if RegistriesYAML("") != "" {
		t.Fatal("no token must produce no registries.yaml")
	}
	got := RegistriesYAML(`gh"o_x`)
	for _, want := range []string{`"ghcr.io":`, "username: oauth2", `password: "gh\"o_x"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}

func TestServerConfigAndResolvConf(t *testing.T) {
	y := ServerConfigYAML()
	for _, want := range []string{"- traefik", "resolv-conf: " + ResolvConfPath} {
		if !strings.Contains(y, want) {
			t.Errorf("config.yaml missing %q:\n%s", want, y)
		}
	}
	r := ResolvConf([]string{"1.1.1.1", "8.8.8.8"})
	if !strings.Contains(r, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n") {
		t.Errorf("bad resolv.conf:\n%s", r)
	}
}

func TestUpstreamDNSOverride(t *testing.T) {
	t.Setenv("PLATFORM_UPSTREAM_DNS", " 10.0.0.2, 10.0.0.3 ,")
	got := upstreamDNS()
	if len(got) != 2 || got[0] != "10.0.0.2" || got[1] != "10.0.0.3" {
		t.Fatalf("got %v", got)
	}
	t.Setenv("PLATFORM_UPSTREAM_DNS", "")
	if d := upstreamDNS(); len(d) != 2 || d[0] != "1.1.1.1" {
		t.Fatalf("default %v", d)
	}
}

func TestCoreDNSOverrideEscapesDomain(t *testing.T) {
	o := CoreDNSOverride("1.2.3.4.sslip.io")
	if !strings.Contains(o, `rewrite name regex (.*)\.1\.2\.3\.4\.sslip\.io ingress-nginx-controller`) ||
		!strings.Contains(o, "rewrite name 1.2.3.4.sslip.io ingress-nginx-controller") {
		t.Fatalf("bad override:\n%s", o)
	}
}
