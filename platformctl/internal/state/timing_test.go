package state

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTimingTableOrderedAndTotals(t *testing.T) {
	ResetTimings()
	base := time.Now()
	RecordTiming(StepTiming{Step: "b", Start: base.Add(time.Second), Duration: 90 * time.Second, Status: "ok"})
	RecordTiming(StepTiming{Step: "a", Start: base, Duration: 30 * time.Second, Status: "cached"})

	var buf bytes.Buffer
	WriteTimingTable(&buf, 100*time.Second)
	out := buf.String()
	if strings.Index(out, "  a ") > strings.Index(out, "  b ") {
		t.Fatalf("entries not ordered by start time:\n%s", out)
	}
	for _, want := range []string{"1m30s", "0m30s", "sum of steps", "2m00s", "wall clock", "1m40s"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestTrackConcurrent(t *testing.T) {
	ResetTimings()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			Track("x")("ok")
		}()
	}
	wg.Wait()
	if n := len(Timings()); n != 20 {
		t.Fatalf("want 20 timings, got %d", n)
	}
}

func TestSaveTimingTable(t *testing.T) {
	ResetTimings()
	Track("k3s")("ok")
	p, err := SaveTimingTable(t.TempDir(), time.Second)
	if err != nil || !strings.HasSuffix(p, "timings.txt") {
		t.Fatalf("save failed: %v %s", err, p)
	}
}

func TestSaveTimingTableWritesJSON(t *testing.T) {
	ResetTimings()
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	RecordTiming(StepTiming{Step: "helm", Start: base.Add(time.Second), Duration: 1500 * time.Millisecond, Status: "failed"})
	RecordTiming(StepTiming{Step: "k3s", Start: base, Duration: 90 * time.Second, Status: "ok"})
	dir := t.TempDir()
	if _, err := SaveTimingTable(dir, 100*time.Second); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "timings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var r TimingReport
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, b)
	}
	if r.WallClockSeconds != 100 || r.SumOfStepsSeconds != 91.5 || len(r.Steps) != 2 {
		t.Fatalf("unexpected totals: %+v", r)
	}
	if r.Steps[0].Step != "k3s" || r.Steps[1].Step != "helm" || r.Steps[1].Status != "failed" || r.Steps[1].DurationSeconds != 1.5 {
		t.Fatalf("steps not ordered by start or wrong values: %+v", r.Steps)
	}
	if !strings.Contains(string(b), `"durationSeconds"`) {
		t.Fatalf("missing field names:\n%s", b)
	}
}

func TestTimingReportEmptyStepsIsArray(t *testing.T) {
	ResetTimings()
	b, _ := json.Marshal(BuildTimingReport(time.Now(), time.Second))
	if !strings.Contains(string(b), `"steps":[]`) {
		t.Fatalf("want empty array, got %s", b)
	}
}
