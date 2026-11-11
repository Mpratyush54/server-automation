package state

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
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

func TestMarkHardeningDone(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state")
	SetPath(p)
	t.Cleanup(func() { SetPath(DefaultPath) })
	if err := os.WriteFile(p, []byte("harden=in_progress\nharden-firewall=in_progress\nharden-ssh=done\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := MarkHardeningDone(); err != nil {
			t.Fatal(err)
		}
		want := []string{"harden", "harden-firewall", "harden-ssh"}
		if got := DoneSteps(); !reflect.DeepEqual(got, want) {
			t.Fatalf("DoneSteps() = %v, want %v", got, want)
		}
		if got := StatusLine(); strings.Contains(got, "resuming:") {
			t.Fatalf("completed hardening still resuming: %s", got)
		}
	}
}

func TestReconcileHardening(t *testing.T) {
	for _, baseline := range []string{"done", "in_progress", ""} {
		t.Run("baseline="+baseline, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "state")
			SetPath(p)
			t.Cleanup(func() { SetPath(DefaultPath) })
			initial := "harden-firewall=in_progress\nharden-ssh=done\nrouting=in_progress\n"
			if baseline != "" {
				initial += "harden=" + baseline + "\n"
			}
			if err := os.WriteFile(p, []byte(initial), 0644); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err := ReconcileHardening(); err != nil {
					t.Fatal(err)
				}
				if got := IsDone("harden-firewall"); got != (baseline == "done") {
					t.Fatalf("firewall done = %v for baseline %q", got, baseline)
				}
				data, err := os.ReadFile(p)
				if err != nil {
					t.Fatal(err)
				}
				wantFirewall := "in_progress"
				if baseline == "done" {
					wantFirewall = "done"
				}
				if !strings.Contains(string(data), "harden-firewall="+wantFirewall+"\n") {
					t.Fatalf("unexpected persisted state: %s", data)
				}
				if !IsDone("harden-ssh") || IsDone("routing") {
					t.Fatal("reconciliation changed unrelated state")
				}
				if got := StatusLine(); strings.Contains(got, "harden-firewall") != (baseline != "done") {
					t.Fatalf("unexpected status: %s", got)
				}
			}
		})
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
