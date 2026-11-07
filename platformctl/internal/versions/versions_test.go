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
	if got := Get("ingress-nginx").Ref(); got != "ingress-nginx/ingress-nginx --version 4.15.1" {
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
