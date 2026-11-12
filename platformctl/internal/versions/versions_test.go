package versions

import (
	"strings"
	"testing"
)

func TestAllChartsPinned(t *testing.T) {
	for _, c := range All() {
		if c.Version == "" || strings.Contains(c.Version, "latest") {
			t.Errorf("%s: version must be pinned, got %q", c.Name, c.Version)
		}
		if c.IsOCI() && !strings.HasPrefix(c.Chart, "oci://") {
			t.Errorf("%s: OCI chart must use an oci:// ref", c.Name)
		}
		if !c.IsOCI() && c.Repo == "" {
			t.Errorf("%s: classic chart needs a repo alias", c.Name)
		}
	}
}

func TestRefFallsBackToRemote(t *testing.T) {
	c := Get("postgresql")
	if got := c.Ref(); !strings.Contains(got, "--version 18.12.18") || !strings.HasPrefix(got, "oci://") {
		t.Fatalf("unexpected ref %q", got)
	}
	if got := Get("ingress-nginx").Ref(); got != "ingress-nginx --repo https://kubernetes.github.io/ingress-nginx --version 4.15.1" {
		t.Fatalf("unexpected ref %q", got)
	}
}

func TestReposExcludeOCI(t *testing.T) {
	r := Repos()
	if _, ok := r[""]; ok {
		t.Fatal("OCI charts must not produce a repo entry")
	}
	if r["argo"] == "" || r["jetstack"] == "" {
		t.Fatalf("missing expected repos: %v", r)
	}
}

func TestEveryChartHasAMirrorReference(t *testing.T) {
	for _, c := range All() {
		want := ChartMirror + "/" + c.BaseName() + " --version " + c.Version
		if got := c.MirrorPullArgs(); got != want || strings.Contains(c.BaseName(), "/") {
			t.Errorf("%s: mirror ref %q, want %q", c.Name, got, want)
		}
	}
	if Get("postgresql").BaseName() != "postgresql" || Get("argo-cd").BaseName() != "argo-cd" {
		t.Fatal("BaseName must strip OCI registry paths")
	}
	if MirrorTag("v1.37.2+k3s1") != "v1.37.2-k3s1" {
		t.Fatal("MirrorTag must replace '+' (not valid in OCI tags)")
	}
}

func TestSplitChartRef(t *testing.T) {
	cases := []struct{ in, name, version string }{
		{"loki-stack-2.10.3", "loki-stack", "2.10.3"},
		{"loki-6.30.1", "loki", "6.30.1"},
		{"cert-manager-v1.21.3", "cert-manager", "v1.21.3"},
		{"prometheus-blackbox-exporter-11.21.1", "prometheus-blackbox-exporter", "11.21.1"},
		{"argocd-image-updater-1.4.2", "argocd-image-updater", "1.4.2"},
		{"foo-1.0.0-rc-1", "foo", "1.0.0-rc-1"},
		{"bar-2.0.0+build.5", "bar", "2.0.0+build.5"},
	}
	for _, c := range cases {
		n, v, ok := SplitChartRef(c.in)
		if !ok || n != c.name || v != c.version {
			t.Errorf("SplitChartRef(%q) = %q %q %v; want %q %q", c.in, n, v, ok, c.name, c.version)
		}
	}
	for _, bad := range []string{"", "loki", "loki-stack", "-1.2.3", "loki-1.2"} {
		if _, _, ok := SplitChartRef(bad); ok {
			t.Errorf("SplitChartRef(%q) should fail", bad)
		}
	}
}

func TestStaticImages(t *testing.T) {
	imgs := StaticImages()
	if len(imgs) != 1 || imgs[0] != KubeVIPImage {
		t.Fatalf("StaticImages = %v", imgs)
	}
	if !strings.HasPrefix(KubeVIPImage, "ghcr.io/kube-vip/kube-vip:v") {
		t.Fatal(KubeVIPImage)
	}
}

// The "loki" pin must never match a loki-stack release (prefix "loki-").
func TestSplitChartRefNeverConfusesLokiStack(t *testing.T) {
	n, _, _ := SplitChartRef("loki-stack-2.10.3")
	if n == Get("loki").BaseName() {
		t.Fatal("loki-stack release parsed as the loki chart")
	}
	if n != Get("loki-stack").BaseName() {
		t.Fatalf("got %q", n)
	}
}
