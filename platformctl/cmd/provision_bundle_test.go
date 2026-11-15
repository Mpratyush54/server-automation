package cmd

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/stack"
)

// provisionSourceStubs makes every network install fail the test unless
// allowed, and records the offline ones.
func provisionSourceStubs(t *testing.T, online bool) *[]string {
	t.Helper()
	a, b, c, d := provisionPrereqsOnline, provisionPrereqsOffline, provisionHelmOnline, provisionHelmOffline
	t.Cleanup(func() {
		provisionPrereqsOnline, provisionPrereqsOffline, provisionHelmOnline, provisionHelmOffline = a, b, c, d
	})
	var calls []string
	provisionPrereqsOnline = func() error {
		if !online {
			t.Fatal("apt mirrors used for a bundle provision")
		}
		calls = append(calls, "apt-online")
		return nil
	}
	provisionHelmOnline = func() error {
		if !online {
			t.Fatal("get.helm.sh used for a bundle provision")
		}
		calls = append(calls, "helm-online")
		return nil
	}
	provisionPrereqsOffline = func(root string) error { calls = append(calls, "apt-bundle:"+filepath.ToSlash(root)); return nil }
	provisionHelmOffline = func(bin string) error { calls = append(calls, "helm-bundle:"+filepath.ToSlash(bin)); return nil }
	return &calls
}

func stageBundle(t *testing.T, files ...string) stack.Paths {
	t.Helper()
	p := stack.Paths{Staging: t.TempDir()}
	for _, f := range files {
		dest := filepath.Join(p.Staging, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

// A complete bundle: packages, Helm and k3s all come from it, nothing is
// downloaded (the online stubs fail the test).
func TestProvisionWithBundleUsesBundleSources(t *testing.T) {
	p := stageBundle(t, "k3s", "k3s-install.sh", "helm",
		"packages/ubuntu-22.04/amd64/Packages", "packages/ubuntu-24.04/amd64/Packages", "packages/ubuntu-24.04/arm64/Packages")
	calls := provisionSourceStubs(t, false)
	s := bundleSources(p, "amd64")
	if !s.k3s {
		t.Fatal("the bundle's staged k3s must be used without download fallback")
	}
	if err := installPrereqs(s); err != nil {
		t.Fatal(err)
	}
	if err := installHelm(s); err != nil {
		t.Fatal(err)
	}
	root := filepath.ToSlash(p.Staging)
	want := []string{"apt-bundle:" + root + "/packages", "helm-bundle:" + root + "/helm"}
	if len(*calls) != 2 || (*calls)[0] != want[0] || (*calls)[1] != want[1] {
		t.Fatalf("calls = %v, want %v", *calls, want)
	}
}

// Without --bundle, provision installs exactly as before.
func TestProvisionWithoutBundleUnchanged(t *testing.T) {
	calls := provisionSourceStubs(t, true)
	var s hostSources
	if err := installPrereqs(s); err != nil {
		t.Fatal(err)
	}
	if err := installHelm(s); err != nil {
		t.Fatal(err)
	}
	if s.k3s || len(*calls) != 2 || (*calls)[0] != "apt-online" || (*calls)[1] != "helm-online" {
		t.Fatalf("sources %+v, calls %v", s, *calls)
	}
}

// A bundle from an older release (no Helm, no packages for this architecture,
// no k3s) keeps the download for what it lacks.
func TestProvisionWithOlderBundleDownloadsWhatItLacks(t *testing.T) {
	p := stageBundle(t, "packages/ubuntu-24.04/arm64/Packages")
	s := bundleSources(p, "amd64")
	if s.packages != "" || s.helm != "" || s.k3s {
		t.Fatalf("sources = %+v", s)
	}
	calls := provisionSourceStubs(t, true)
	if err := installPrereqs(s); err != nil {
		t.Fatal(err)
	}
	if err := installHelm(s); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 || (*calls)[0] != "apt-online" || (*calls)[1] != "helm-online" {
		t.Fatalf("calls = %v", *calls)
	}
}
