package cmd

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/bundle"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/images"
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

func cairnManifest(tag string) bundle.Manifest {
	return bundle.Manifest{PlatformImageTag: tag, PlatformImages: []string{
		"ghcr.io/mpratyush54/platform-api:" + tag + "@sha256:" + strings.Repeat("a", 64),
		"ghcr.io/mpratyush54/platform-portal:" + tag + "@sha256:" + strings.Repeat("b", 64),
	}}
}

// A bundle provision uses the bundle's Cairn images unless the operator chose
// another tag (environment or saved .env), which is kept with a warning.
func TestApplyBundleImageTag(t *testing.T) {
	for _, tc := range []struct {
		name, tag, source, registry string
		manifest                    bundle.Manifest
		wantTag                     string
		wantChanged                 bool
	}{
		{name: "default tag replaced", tag: "latest", manifest: cairnManifest("1.4.0"), wantTag: "1.4.0", wantChanged: true},
		{name: "same tag", tag: "1.4.0", manifest: cairnManifest("1.4.0"), wantTag: "1.4.0"},
		{name: "explicit tag kept", tag: "1.3.0", source: config.ImageTagFromEnv, manifest: cairnManifest("1.4.0"), wantTag: "1.3.0"},
		{name: "saved tag kept", tag: "1.3.0", source: config.ImageTagSaved, manifest: cairnManifest("1.4.0"), wantTag: "1.3.0"},
		{name: "older bundle", tag: "latest", manifest: bundle.Manifest{}, wantTag: "latest"},
		{name: "other registry", tag: "latest", registry: "registry.example.com/cairn", manifest: cairnManifest("1.4.0"), wantTag: "latest"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			registry := tc.registry
			if registry == "" {
				registry = "ghcr.io/mpratyush54"
			}
			c := &config.Config{ImageRegistry: registry, ImageTag: tc.tag, ImageTagSource: tc.source}
			if changed := applyBundleImageTag(c, tc.manifest); changed != tc.wantChanged || c.ImageTag != tc.wantTag {
				t.Fatalf("changed=%v tag=%q, want %v %q", changed, c.ImageTag, tc.wantChanged, tc.wantTag)
			}
		})
	}
}

// After import, the Cairn images get their digest names too, so the API and
// portal resolve by digest (rollbacks, `platformctl update`) without a registry.
func TestBundleDigestRefsIncludeCairnImages(t *testing.T) {
	dir := t.TempDir()
	refs, err := bundleDigestRefs(dir)
	if err != nil || len(refs) != len(images.DigestPinned()) {
		t.Fatalf("without a staged manifest: %v %v", refs, err)
	}
	m := cairnManifest("1.4.0")
	data := `{"platformImageTag":"1.4.0","platformImages":["` + strings.Join(m.PlatformImages, `","`) + `"]}`
	if err := os.WriteFile(filepath.Join(dir, bundle.ManifestFile), []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	refs, err = bundleDigestRefs(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range m.PlatformImages {
		if !slices.Contains(refs, want) {
			t.Fatalf("%s missing from %v", want, refs)
		}
	}
	for _, ref := range m.PlatformImages {
		if _, _, ok := images.DigestAlias(ref); !ok {
			t.Fatalf("%s cannot be named by digest", ref)
		}
	}
}
