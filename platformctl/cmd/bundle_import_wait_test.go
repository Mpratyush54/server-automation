package cmd

import (
	"testing"
	"time"
)

func TestPendingImports(t *testing.T) {
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
	oa, ol, ot, op, on, os := bundleImportArchives, k3sImportLog, bundleImportTimeout, bundleImportPoll, bundleImportNow, bundleImportSleep
	t.Cleanup(func() {
		bundleImportArchives, k3sImportLog, bundleImportTimeout, bundleImportPoll, bundleImportNow, bundleImportSleep = oa, ol, ot, op, on, os
	})
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
