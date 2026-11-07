package state

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultLogDir holds per-step logs and the timing summary for a provision run.
const DefaultLogDir = "/var/log/platformctl"

// StepTiming is one step's wall-clock time in the current run.
type StepTiming struct {
	Step     string
	Start    time.Time
	Duration time.Duration
	Status   string // ok | failed | skipped | cached
}

var (
	timingMu sync.Mutex
	timings  []StepTiming
)

// Track starts timing a step and returns a func that records its outcome.
// Safe for concurrent use; the order in the summary is by start time.
func Track(step string) func(status string) {
	start := time.Now()
	return func(status string) {
		RecordTiming(StepTiming{Step: step, Start: start, Duration: time.Since(start), Status: status})
	}
}

// RecordTiming stores a completed timing entry.
func RecordTiming(t StepTiming) {
	timingMu.Lock()
	defer timingMu.Unlock()
	timings = append(timings, t)
}

// Timings returns this run's entries sorted by start time.
func Timings() []StepTiming {
	timingMu.Lock()
	defer timingMu.Unlock()
	out := append([]StepTiming(nil), timings...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	return out
}

// ResetTimings clears recorded entries (tests).
func ResetTimings() {
	timingMu.Lock()
	defer timingMu.Unlock()
	timings = nil
}

// WriteTimingTable renders the summary: per-step duration plus total wall time.
func WriteTimingTable(w io.Writer, total time.Duration) {
	ts := Timings()
	width := len("step")
	for _, t := range ts {
		if len(t.Step) > width {
			width = len(t.Step)
		}
	}
	fmt.Fprintf(w, "  %-*s  %9s  %s\n", width, "step", "duration", "status")
	fmt.Fprintf(w, "  %s\n", strings.Repeat("-", width+21))
	var sum time.Duration
	for _, t := range ts {
		sum += t.Duration
		fmt.Fprintf(w, "  %-*s  %9s  %s\n", width, t.Step, fmtDur(t.Duration), t.Status)
	}
	fmt.Fprintf(w, "  %s\n", strings.Repeat("-", width+21))
	fmt.Fprintf(w, "  %-*s  %9s\n", width, "sum of steps", fmtDur(sum))
	fmt.Fprintf(w, "  %-*s  %9s\n", width, "wall clock", fmtDur(total))
}

// SaveTimingTable writes the summary to <dir>/timings.txt (best effort).
func SaveTimingTable(dir string, total time.Duration) (string, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	p := filepath.Join(dir, "timings.txt")
	f, err := os.Create(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	fmt.Fprintf(f, "platformctl provision — %s\n\n", time.Now().UTC().Format(time.RFC3339))
	WriteTimingTable(f, total)
	return p, nil
}

func fmtDur(d time.Duration) string {
	d = d.Round(time.Second)
	m := int(d / time.Minute)
	s := int((d % time.Minute) / time.Second)
	return fmt.Sprintf("%dm%02ds", m, s)
}
