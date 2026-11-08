package k3s

import (
	"errors"
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
	for _, want := range []string{"- traefik", "resolv-conf: " + ResolvConfPath, "secrets-encryption: true"} {
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

// Regression: during a GitHub Releases outage get.k3s.io could not download
// the k3s binary and provision stopped. Fall back to the GHCR mirror.
func TestInstallK3sFallsBackToMirror(t *testing.T) {
	origUp, origMirror := installUpstream, installFromMirror
	t.Cleanup(func() { installUpstream, installFromMirror = origUp, origMirror })

	mirrored := 0
	installUpstream = func() error { return errors.New("exit status 22") }
	installFromMirror = func() error { mirrored++; return nil }
	if err := installK3s(); err != nil || mirrored != 1 {
		t.Fatalf("expected mirror install, err=%v mirrored=%d", err, mirrored)
	}

	installUpstream = func() error { return nil }
	if err := installK3s(); err != nil || mirrored != 1 {
		t.Fatalf("mirror must not be used when upstream works (mirrored=%d)", mirrored)
	}

	installUpstream = func() error { return errors.New("upstream down") }
	installFromMirror = func() error { return errors.New("mirror down") }
	if err := installK3s(); err == nil || !strings.Contains(err.Error(), "upstream down") || !strings.Contains(err.Error(), "mirror down") {
		t.Fatalf("expected both causes, got %v", err)
	}
	if k3sMirrorFile("amd64") != "k3s" || k3sMirrorFile("arm64") != "k3s-arm64" {
		t.Fatal("mirror file names must match the k3s release assets")
	}
}
