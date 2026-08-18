package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkDoneDedupes(t *testing.T) {
	dir := t.TempDir()
	SetPath(filepath.Join(dir, "state"))
	t.Cleanup(func() { SetPath(DefaultPath) })

	if err := MarkDone("argocd"); err != nil {
		t.Fatal(err)
	}
	if err := MarkDone("argocd"); err != nil {
		t.Fatal(err)
	}
	if err := MarkDone("portainer"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if count := countSub(s, "argocd=done"); count != 1 {
		t.Fatalf("want 1 argocd=done, got %d in %q", count, s)
	}
	if !IsDone("argocd") || !IsDone("portainer") {
		t.Fatal("expected both done")
	}
}

func TestLockInfoMissingFile(t *testing.T) {
	dir := t.TempDir()
	SetLockPath(filepath.Join(dir, "missing.lock"))
	t.Cleanup(func() { SetLockPath(DefaultLockPath) })

	meta, err := LockInfo()
	if err != nil {
		t.Fatal(err)
	}
	if meta != "" {
		t.Fatalf("expected empty lock info, got %q", meta)
	}
}

func TestMarkInProgressDoesNotDowngrade(t *testing.T) {
	dir := t.TempDir()
	SetPath(filepath.Join(dir, "state"))
	t.Cleanup(func() { SetPath(DefaultPath) })

	_ = MarkDone("routing")
	_ = MarkInProgress("routing")
	if !IsDone("routing") {
		t.Fatal("in_progress must not overwrite done")
	}
}

func countSub(s, sub string) int {
	n := 0
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			n++
		}
	}
	return n
}
