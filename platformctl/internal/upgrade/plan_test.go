package upgrade

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCompatibility(t *testing.T) {
	for _, tt := range []struct {
		from, to, min string
		patch, ok     bool
	}{
		{"v1.2.3", "1.3.0", "", false, true}, {"1.2.3", "1.2.4", "", true, true}, {"1.2.3", "1.3.0", "", true, false},
		{"1.2.3", "2.0.0", "", false, false}, {"1.2.3", "2.0.0", "1.2.0", false, true}, {"1.2.3", "3.0.0", "1.0.0", false, false},
		{"1.2.3", "1.2.2", "", false, false}, {"1.2.3", "1.3.0", "1.2.4", false, false}, {"dev", "1.3.0", "", false, false},
		{"1.3.0-rc.2", "1.3.0-rc.10", "", false, true}, {"1.3.0-rc.10", "1.3.0-rc.2", "", false, false},
		{"1.2.3", "1.2.4-rc.1", "", true, false}, {"1.2.3", "1.2.3", "", false, true},
	} {
		t.Run(tt.from+"_"+tt.to, func(t *testing.T) {
			e := Compatible(tt.from, tt.to, Rules{MinimumSource: tt.min}, tt.patch)
			if (e == nil) != tt.ok {
				t.Fatalf("compatible=%v: %v", tt.ok, e)
			}
		})
	}
	for _, s := range []string{"latest", "v1.2", "v01.2.3", "1.2.3;id", "1.2.3/evil"} {
		if _, e := Parse(s); e == nil {
			t.Fatalf("accepted %q", s)
		}
	}
}
func TestPlanOnlyChangedInstalledResources(t *testing.T) {
	images := []Image{{Deployment: "api", Before: "old", After: "new"}, {Deployment: "portal", Before: "same", After: "same"}}
	p := Compute([]Chart{{Name: "postgres", Chart: "postgresql", Version: "1", Revision: 7}, {Name: "redis", Chart: "redis", Version: "2"}}, map[string]string{"postgresql": "2", "redis": "2", "minio": "3"}, images)
	if len(p.Charts) != 1 || p.Charts[0].Version != "2" || p.Charts[0].Revision != 7 || len(p.Images) != 1 {
		t.Fatalf("%+v", p)
	}
}
func TestHistoryAtomicAppendAndCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "history.json")
	h, e := ReadHistory(path)
	if e != nil || len(h) != 0 {
		t.Fatal(h, e)
	}
	for _, s := range []string{"started", "succeeded"} {
		if _, e = AppendHistory(path, Record{From: "1.0.0", To: "1.1.0", Status: s}); e != nil {
			t.Fatal(e)
		}
	}
	h, e = ReadHistory(path)
	if e != nil || len(h) != 2 || h[1].Status != "succeeded" {
		t.Fatal(h, e)
	}
	if e = os.WriteFile(path, []byte("broken"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = AppendHistory(path, Record{}); e == nil {
		t.Fatal("overwrote corrupt history")
	}
}
func TestTransactionFailureAndRollback(t *testing.T) {
	for _, failure := range []string{"", "backup", "migrate", "chart", "image", "health", "rollback"} {
		t.Run(failure, func(t *testing.T) {
			var events []string
			var last Record
			healthCalls := 0
			hook := func(s string) error {
				events = append(events, s)
				if failure == s {
					return errors.New(s)
				}
				return nil
			}
			h := Hooks{Save: func(r Record) error { last = r; return nil }, Backup: func() (string, error) { return "backup-id", hook("backup") }, Migrate: func() error { return hook("migrate") }, Chart: func(Chart) error { return hook("chart") }, Image: func(i Image, rb bool) error {
				if rb {
					return hook("undo-" + i.Deployment)
				}
				return hook("image")
			}, RollbackChart: func(Chart) error { return hook("rollback") }, Health: func() error {
				healthCalls++
				events = append(events, "health")
				if healthCalls == 1 && (failure == "health" || failure == "rollback") {
					return errors.New("unhealthy")
				}
				return nil
			}}
			e := Apply(Record{Plan: Plan{Charts: []Chart{{Name: "db", Revision: 4}}, Images: []Image{{Deployment: "api"}, {Deployment: "portal"}}}}, h)
			if failure == "" {
				if e != nil || last.Status != "succeeded" || last.Backup != "backup-id" {
					t.Fatal(e, last)
				}
				return
			}
			if e == nil {
				t.Fatal("expected failure")
			}
			if failure == "backup" && strings.Contains(strings.Join(events, ","), "migrate") {
				t.Fatal(events)
			}
			if failure == "migrate" && strings.Contains(strings.Join(events, ","), "chart") {
				t.Fatal(events)
			}
			if failure == "health" {
				want := []string{"backup", "migrate", "chart", "image", "image", "health", "undo-portal", "undo-api", "rollback", "health"}
				if !reflect.DeepEqual(events, want) || last.Status != "rolled-back" {
					t.Fatal(events, last)
				}
			}
			if failure == "rollback" && (!strings.Contains(e.Error(), "requires attention") || last.Status != "failed") {
				t.Fatal(e, last)
			}
		})
	}
}
func TestNoBackupWhenIntentCannotBeSaved(t *testing.T) {
	e := Apply(Record{}, Hooks{Save: func(Record) error { return errors.New("disk full") }, Backup: func() (string, error) { t.Fatal("backup ran"); return "", nil }})
	if e == nil {
		t.Fatal("expected error")
	}
}

func TestInstallBinaryUsesInjectedPaths(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "target")
	dst := filepath.Join(dir, "platformctl")
	if e := os.WriteFile(src, []byte("target binary"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(dst, []byte("old binary"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := InstallBinary(src, dst); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(dst)
	if e != nil || string(b) != "target binary" {
		t.Fatal(string(b), e)
	}
}

// Commit runs only after a passing health gate; a failing commit rolls back.
func TestCommitAfterHealthAndRollbackOnCommitFailure(t *testing.T) {
	for _, commitErr := range []error{nil, errors.New("read-only fs")} {
		var events []string
		var last Record
		h := Hooks{
			Save:          func(r Record) error { last = r; return nil },
			Backup:        func() (string, error) { return "b", nil },
			Migrate:       func() error { return nil },
			Chart:         func(Chart) error { return nil },
			RollbackChart: func(Chart) error { events = append(events, "rollback"); return nil },
			Image: func(i Image, rb bool) error {
				if rb {
					events = append(events, "undo")
				}
				return nil
			},
			Health: func() error { events = append(events, "health"); return nil },
			Commit: func() error { events = append(events, "commit"); return commitErr },
		}
		e := Apply(Record{Plan: Plan{Images: []Image{{Deployment: "platform-api", Before: "a", After: "b"}}}}, h)
		if commitErr == nil {
			if e != nil || last.Status != "succeeded" || strings.Join(events, ",") != "health,commit" {
				t.Fatalf("e=%v status=%s events=%v", e, last.Status, events)
			}
			continue
		}
		if e == nil || last.Status != "rolled-back" || strings.Join(events, ",") != "health,commit,undo,health" {
			t.Fatalf("e=%v status=%s events=%v", e, last.Status, events)
		}
	}
}
