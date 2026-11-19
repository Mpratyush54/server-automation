package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPendingImports(t *testing.T) {
	oc := importCached
	t.Cleanup(func() { importCached = oc })
	importCached = func(string) bool { return false }
	dir := "/var/lib/rancher/k3s/agent/images/"
	archives := []string{dir + "k3s-airgap-images-amd64.tar.zst", dir + "cairn-images-amd64.tar.zst", dir + "platform-images-amd64.tar.zst"}
	// The offline test's log when the node was Ready: the big archive was still importing.
	log := `Importing images from ` + dir + `cairn-images-amd64.tar.zst
Imported 4 images from ` + dir + `cairn-images-amd64.tar.zst in 51.05s
Imported 8 images from ` + dir + `k3s-airgap-images-amd64.tar.zst in 4.91s
Importing images from ` + dir + `platform-images-amd64.tar.zst`
	got := pendingImports(archives, log)
	if len(got) != 1 || got[0] != "platform-images-amd64.tar.zst" {
		t.Fatalf("pending=%v", got)
	}
	log += "\nImported 61 images from " + dir + "platform-images-amd64.tar.zst in 9m2s"
	if got := pendingImports(archives, log); len(got) != 0 {
		t.Fatalf("pending=%v", got)
	}
}

func stubImportWait(t *testing.T, archives []string, logs []string) *int {
	t.Helper()
	oa, ol, ot, op, on, osl, oc := bundleImportArchives, k3sImportLog, bundleImportTimeout, bundleImportPoll, bundleImportNow, bundleImportSleep, importCached
	t.Cleanup(func() {
		bundleImportArchives, k3sImportLog, bundleImportTimeout, bundleImportPoll, bundleImportNow, bundleImportSleep, importCached = oa, ol, ot, op, on, osl, oc
	})
	importCached = func(string) bool { return false }
	now := time.Unix(0, 0)
	calls := 0
	bundleImportArchives = func() []string { return archives }
	k3sImportLog = func() string {
		i := calls
		if i >= len(logs) {
			i = len(logs) - 1
		}
		calls++
		return logs[i]
	}
	bundleImportTimeout, bundleImportPoll = time.Minute, 10*time.Second
	bundleImportNow = func() time.Time { return now }
	bundleImportSleep = func(d time.Duration) { now = now.Add(d) }
	return &calls
}

func TestWaitBundleImportsUntilEveryArchiveIsImported(t *testing.T) {
	a := []string{"/i/big.tar.zst"}
	calls := stubImportWait(t, a, []string{"Importing images from /i/big.tar.zst", "Importing images from /i/big.tar.zst", "Imported 61 images from /i/big.tar.zst in 9m"})
	waitBundleImports()
	if *calls != 3 {
		t.Fatalf("log reads=%d, want 3 (wait until imported)", *calls)
	}
}

func TestWaitBundleImportsGivesUpAfterTimeout(t *testing.T) {
	calls := stubImportWait(t, []string{"/i/big.tar.zst"}, []string{""})
	waitBundleImports()
	if *calls != 8 { // t=0..60s every 10s, plus the check past the deadline
		t.Fatalf("log reads=%d", *calls)
	}
}

func TestWaitBundleImportsWithoutArchives(t *testing.T) {
	calls := stubImportWait(t, nil, []string{""})
	waitBundleImports()
	if *calls != 0 {
		t.Fatal("no archives: nothing to wait for")
	}
}

// With k3s's import cache enabled, unchanged archives are skipped on a k3s
// restart without any log line: the cache entry counts as imported.
func TestArchiveInImportCache(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "platform-images-amd64-1.tar.zst")
	if err := os.WriteFile(a, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	mt := time.Date(2026, 11, 19, 4, 46, 3, 0, time.UTC)
	if err := os.Chtimes(a, mt, mt); err != nil {
		t.Fatal(err)
	}
	write := func(s string) {
		if err := os.WriteFile(filepath.Join(dir, ".cache.json"), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if archiveInImportCache(a) {
		t.Fatal("no cache file: not imported")
	}
	write("")
	if archiveInImportCache(a) {
		t.Fatal("empty cache (just enabled): not imported")
	}
	key, _ := json.Marshal(a)
	write(`{` + string(key) + `:{"size":5,"modTime":"2026-11-19T04:46:03Z","images":["a"]}}`)
	if !archiveInImportCache(a) {
		t.Fatal("cache entry with the same size and mtime: imported")
	}
	write(`{` + string(key) + `:{"size":4,"modTime":"2026-11-19T04:46:03Z","images":["a"]}}`)
	if archiveInImportCache(a) {
		t.Fatal("size changed: k3s re-imports it")
	}
	write(`{` + string(key) + `:{"size":5,"modTime":"2026-11-19T04:46:02Z","images":["a"]}}`)
	if archiveInImportCache(a) {
		t.Fatal("file newer than the cache entry: k3s re-imports it")
	}
}

func TestPendingImportsCountsCachedArchives(t *testing.T) {
	oc := importCached
	t.Cleanup(func() { importCached = oc })
	importCached = func(a string) bool { return a == "/i/cached.tar.zst" }
	got := pendingImports([]string{"/i/cached.tar.zst", "/i/new.tar.zst"}, "")
	if len(got) != 1 || got[0] != "new.tar.zst" {
		t.Fatalf("pending=%v", got)
	}
}
