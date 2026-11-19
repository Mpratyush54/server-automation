package k3s

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func TestImageImportCacheIsInK3sImagesDir(t *testing.T) {
	if filepath.ToSlash(ImageImportCache) != "/var/lib/rancher/k3s/agent/images/.cache.json" {
		t.Fatalf("k3s only reads .cache.json from its images dir, got %s", ImageImportCache)
	}
}

// An empty file enables k3s's conditional import; an existing cache (written
// by k3s after importing) must survive re-runs, or the next start re-imports.
func TestEnableImageImportCacheCreatesEmptyAndKeepsExisting(t *testing.T) {
	old := ImageImportCache
	t.Cleanup(func() { ImageImportCache = old })
	ImageImportCache = filepath.Join(t.TempDir(), "agent", "images", ".cache.json")

	if err := EnableImageImportCache(); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(ImageImportCache); err != nil || len(b) != 0 {
		t.Fatalf("want an empty cache file, got %q, %v", b, err)
	}
	filled := `{"/var/lib/rancher/k3s/agent/images/a.tar.zst":{"size":1}}`
	if err := os.WriteFile(ImageImportCache, []byte(filled), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnableImageImportCache(); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(ImageImportCache); string(b) != filled {
		t.Fatalf("existing cache was changed: %q", b)
	}
}

// k3s keeps the mtime with second precision (metav1.Time) and re-imports a file
// whose mtime is after it: archives must have whole-second mtimes.
func TestEnableImageImportCacheRoundsArchiveMtimes(t *testing.T) {
	old := ImageImportCache
	t.Cleanup(func() { ImageImportCache = old })
	dir := t.TempDir()
	ImageImportCache = filepath.Join(dir, ".cache.json")
	sub := time.Date(2026, 11, 19, 4, 46, 3, 123456789, time.UTC)
	for _, n := range []string{"platform-images-amd64-1.tar.zst", "x.tar", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(filepath.Join(dir, n), sub, sub); err != nil {
			t.Fatal(err)
		}
	}
	if err := EnableImageImportCache(); err != nil {
		t.Fatal(err)
	}
	for n, want := range map[string]time.Time{
		"platform-images-amd64-1.tar.zst": sub.Truncate(time.Second),
		"x.tar":                           sub.Truncate(time.Second),
	} {
		fi, err := os.Stat(filepath.Join(dir, n))
		if err != nil {
			t.Fatal(err)
		}
		if !fi.ModTime().Equal(want) {
			t.Errorf("%s mtime %v, want %v", n, fi.ModTime().UTC(), want)
		}
	}
	if fi, _ := os.Stat(filepath.Join(dir, "notes.txt")); fi.ModTime().Equal(fi.ModTime().Truncate(time.Second)) {
		t.Error("notes.txt is not an archive and must keep its mtime")
	}
}

// A joined server keeps the whole platform stack in agent/images; the cache
// must exist before k3s first starts, so the first import is recorded.
func TestJoinEnablesImageImportCacheBeforeK3sStarts(t *testing.T) {
	tokenPaths(t)
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	t.Cleanup(func() { state.SetPath(state.DefaultPath) })
	a, b, c, d, e, f, g, h := joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig
	t.Cleanup(func() {
		joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig = a, b, c, d, e, f, g, h
	})
	joinWriteToken = func(string, string) error { return nil }
	joinWriteRegistries = func(string) (bool, error) { return false, nil }
	joinWriteConfig = func(string, []string) (bool, error) { return true, nil }
	joinIsInstalled = func() bool { return false }
	cacheAtInstall := false
	joinInstall = func(string) error {
		_, err := os.Stat(ImageImportCache)
		cacheAtInstall = err == nil
		return nil
	}
	joinRestart = func(string) error { return nil }
	joinWaitReady = func() error { return nil }
	joinSetupKubeconfig = func() error { return nil }
	if err := Join(RoleServer, "https://node:6443", "secret-token", "", ServerOptions{NodeIP: "10.0.0.2"}); err != nil {
		t.Fatal(err)
	}
	if !cacheAtInstall {
		t.Fatal("k3s was installed (and started) before the image import cache existed")
	}
}
