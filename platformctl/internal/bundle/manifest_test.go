package bundle

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testManifest = `{"version":"v1.4.0","arch":"amd64","platformImageTag":"1.4.0",` +
	`"platformImages":["ghcr.io/mpratyush54/platform-api:1.4.0@sha256:` + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + `"]}`

// manifestEntries is goodEntries with a manifest that SHA256SUMS covers, as
// build-bundle.sh writes it, plus the Cairn image archive.
func manifestEntries(manifest string) []entry {
	entries := goodEntries()
	entries[0].body += sha(manifest) + "  manifest.json\n" + sha("cairn") + "  images/cairn-images-amd64.tar.zst\n"
	entries[1].body = manifest
	return append(entries, entry{name: "images/cairn-images-amd64.tar.zst", body: "cairn"})
}

func TestReadManifestFromArchive(t *testing.T) {
	p := buildBundle(t, t.TempDir(), manifestEntries(testManifest))
	m, err := ReadManifest(p)
	if err != nil {
		t.Fatal(err)
	}
	if m.PlatformImageTag != "1.4.0" || len(m.PlatformImages) != 1 || !strings.Contains(m.PlatformImages[0], "platform-api:1.4.0@sha256:") {
		t.Fatalf("manifest = %+v", m)
	}

	bad := manifestEntries(testManifest)
	bad[1].body = strings.Replace(testManifest, "1.4.0", "9.9.9", 1)
	if _, err := ReadManifest(buildBundle(t, t.TempDir(), bad)); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("tampered manifest: %v", err)
	}
	invalid := strings.Replace(testManifest, `"platformImageTag":"1.4.0"`, `"platformImageTag":"1.4.0; rm -rf /"`, 1)
	if _, err := ReadManifest(buildBundle(t, t.TempDir(), manifestEntries(invalid))); err == nil {
		t.Fatal("invalid tag accepted")
	}
}

// Install stages a checksummed manifest and puts the Cairn image archive
// where k3s imports it; a bundle from an older release (manifest not in
// SHA256SUMS) stages none and clears a stale one.
func TestInstallStagesManifestAndCairnImages(t *testing.T) {
	opts := testOpts(t)
	if err := InstallWithOptions(buildBundle(t, t.TempDir(), manifestEntries(testManifest)), opts); err != nil {
		t.Fatal(err)
	}
	assertFile(t, filepath.Join(opts.ImagesDir, "cairn-images-amd64.tar.zst"), "cairn")
	m, ok, err := ReadStagedManifest(opts.StagingDir)
	if err != nil || !ok || m.PlatformImageTag != "1.4.0" {
		t.Fatalf("staged manifest: %+v %v %v", m, ok, err)
	}
	want := []string{"ghcr.io/mpratyush54/platform-api:1.4.0@sha256:" + strings.Repeat("a", 64)}
	if !reflect.DeepEqual(m.PlatformImages, want) {
		t.Fatal(m.PlatformImages)
	}

	if err := InstallWithOptions(buildBundle(t, t.TempDir(), goodEntries()), opts); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := ReadStagedManifest(opts.StagingDir); ok || err != nil {
		t.Fatalf("older bundle left a staged manifest: %v %v", ok, err)
	}
	if _, err := os.Stat(filepath.Join(opts.StagingDir, ManifestFile)); !os.IsNotExist(err) {
		t.Fatal("stale manifest kept")
	}
}
