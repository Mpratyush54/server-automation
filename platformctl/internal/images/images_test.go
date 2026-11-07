package images

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fake is a scriptable Runner.
type fake struct {
	mu       sync.Mutex
	present  map[string]bool
	failures map[string]int // pull failures to return before succeeding
	pulls    map[string]int
	inFlight int32
	maxSeen  int32
	delay    time.Duration
}

func newFake() *fake {
	return &fake{present: map[string]bool{}, failures: map[string]int{}, pulls: map[string]int{}}
}

func (f *fake) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if name != "k3s" || len(args) != 3 || args[0] != "crictl" {
		return nil, errors.New("unexpected command")
	}
	img := args[2]
	switch args[1] {
	case "inspecti":
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.present[img] {
			return nil, nil
		}
		return []byte("not found"), errors.New("exit status 1")
	case "pull":
		n := atomic.AddInt32(&f.inFlight, 1)
		defer atomic.AddInt32(&f.inFlight, -1)
		for {
			m := atomic.LoadInt32(&f.maxSeen)
			if n <= m || atomic.CompareAndSwapInt32(&f.maxSeen, m, n) {
				break
			}
		}
		if f.delay > 0 {
			select {
			case <-time.After(f.delay):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.pulls[img]++
		if f.failures[img] > 0 {
			f.failures[img]--
			return []byte("transient"), errors.New("exit status 1")
		}
		return nil, nil
	}
	return nil, errors.New("unexpected subcommand")
}

// setup installs the fake runner and a test image list; restored on cleanup.
func setup(t *testing.T, list string) *fake {
	t.Helper()
	f := newFake()
	oldRun, oldTxt, oldLog, oldBackoff := Run, imagesTxt, LogPath, Backoff
	Run, imagesTxt = f.run, list
	LogPath = filepath.Join(t.TempDir(), "sub", "prepull.log")
	Backoff = func(int) time.Duration { return time.Millisecond }
	t.Cleanup(func() { Run, imagesTxt, LogPath, Backoff = oldRun, oldTxt, oldLog, oldBackoff })
	return f
}

func TestParseDedupeAndComments(t *testing.T) {
	got := parse("# header\n\n  a:1  \nb:2\n#c:3\na:1\r\n\tb:2\nc:3\n")
	want := []string{"a:1", "b:2", "c:3"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parse = %v, want %v", got, want)
	}
}

func TestEmbeddedListSane(t *testing.T) {
	l := List()
	if len(l) == 0 {
		t.Fatal("embedded images.txt is empty")
	}
	hasInfisical := false
	for _, img := range l {
		if strings.ContainsAny(img, " \t#") {
			t.Errorf("bad image ref %q", img)
		}
		if strings.Contains(img, "platform-api") || strings.Contains(img, "platform-portal") {
			t.Errorf("%s must be passed as extra, not embedded", img)
		}
		if img == "infisical/infisical:latest-postgres" {
			hasInfisical = true
		}
	}
	if !hasInfisical {
		t.Error("infisical image missing from images.txt")
	}
}

func TestConcurrencyCap(t *testing.T) {
	var list strings.Builder
	for _, c := range "abcdefghijkl" {
		list.WriteString(string(c) + ":1\n")
	}
	f := setup(t, list.String())
	f.delay = 20 * time.Millisecond
	res := PrePull(context.Background(), 3)
	if len(res.Pulled) != 12 || len(res.Failed) != 0 {
		t.Fatalf("pulled %d failed %v", len(res.Pulled), res.Failed)
	}
	if m := atomic.LoadInt32(&f.maxSeen); m > 3 || m < 2 {
		t.Fatalf("max concurrent pulls = %d, want <=3 (and >1 to prove parallelism)", m)
	}
}

func TestSkipPresentAndExtras(t *testing.T) {
	f := setup(t, "a:1\nb:2\n")
	f.present["a:1"] = true
	res := PrePull(context.Background(), 2, " c:3 ", "", "b:2")
	if !reflect.DeepEqual(res.Skipped, []string{"a:1"}) {
		t.Fatalf("skipped = %v", res.Skipped)
	}
	if !reflect.DeepEqual(res.Pulled, []string{"b:2", "c:3"}) {
		t.Fatalf("pulled = %v", res.Pulled)
	}
	if f.pulls["a:1"] != 0 || f.pulls["b:2"] != 1 {
		t.Fatalf("pull counts = %v", f.pulls)
	}
}

func TestRetryThenSuccess(t *testing.T) {
	f := setup(t, "flaky:1\ndead:1\n")
	f.failures["flaky:1"] = 2
	f.failures["dead:1"] = 99
	res := PrePull(context.Background(), 2)
	if !reflect.DeepEqual(res.Pulled, []string{"flaky:1"}) {
		t.Fatalf("pulled = %v", res.Pulled)
	}
	if f.pulls["flaky:1"] != 3 {
		t.Fatalf("flaky pulled %d times, want 3", f.pulls["flaky:1"])
	}
	if res.Failed["dead:1"] == nil || f.pulls["dead:1"] != MaxAttempts {
		t.Fatalf("dead: err=%v attempts=%d", res.Failed["dead:1"], f.pulls["dead:1"])
	}
}

func TestContextCancel(t *testing.T) {
	var list strings.Builder
	for _, c := range "abcdefghij" {
		list.WriteString(string(c) + ":1\n")
	}
	f := setup(t, list.String())
	f.delay = time.Second
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(30 * time.Millisecond); cancel() }()
	t0 := time.Now()
	res := PrePull(ctx, 2)
	if d := time.Since(t0); d > 500*time.Millisecond {
		t.Fatalf("PrePull took %s after cancel", d)
	}
	if len(res.Pulled) != 0 || len(res.Failed) != 10 {
		t.Fatalf("pulled=%v failed=%d", res.Pulled, len(res.Failed))
	}
	for img, err := range res.Failed {
		if !errors.Is(err, context.Canceled) {
			t.Errorf("%s: err = %v, want context.Canceled", img, err)
		}
	}
}

func TestUnwritableLogFallsBack(t *testing.T) {
	setup(t, "a:1\n")
	LogPath = filepath.Join(t.TempDir(), "file")
	// Make the log "directory" a regular file so MkdirAll fails.
	if err := os.WriteFile(LogPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	LogPath = filepath.Join(LogPath, "prepull.log")
	if res := PrePull(context.Background(), 1); len(res.Pulled) != 1 {
		t.Fatalf("pulled = %v", res.Pulled)
	}
}
