package state

import (
	"bytes"
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
