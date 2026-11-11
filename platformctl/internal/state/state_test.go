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

func TestGetSetAuxiliaryRecords(t *testing.T) {
	SetPath(filepath.Join(t.TempDir(), "state"))
	defer SetPath(DefaultPath)
	if err := MarkDone("postgresql"); err != nil {
		t.Fatal(err)
	}
	if err := Set("postgresql.values", "abc123"); err != nil {
		t.Fatal(err)
	}
	if Get("postgresql.values") != "abc123" || !IsDone("postgresql") {
		t.Fatal("record lost")
	}
	for _, s := range DoneSteps() {
		if s == "postgresql.values" {
			t.Fatal("auxiliary record listed as a done step")
		}
	}
	if Set("bad\nkey", "x") == nil || Set("k", "a\nb") == nil {
		t.Fatal("accepted a newline")
	}
}
