package state

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// TestHelperMarkDone is re-executed as a child process by
// TestMarkDoneAcrossProcesses; it is a no-op in a normal test run.
func TestHelperMarkDone(t *testing.T) {
	p, step := os.Getenv("STATE_HELPER_PATH"), os.Getenv("STATE_HELPER_STEP")
	if p == "" {
		return
	}
	SetPath(p)
	for i := 0; i < 20; i++ {
		if err := MarkDone(fmt.Sprintf("%s-%d", step, i)); err != nil {
			t.Fatal(err)
		}
	}
}

// Parallel provision runs steps as separate processes that all write the
// state file; no process may lose another's "done" entries.
func TestMarkDoneAcrossProcesses(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("cross-process lock is Unix-only (production is Linux)")
	}
	p := filepath.Join(t.TempDir(), "state")
	const procs = 6
	var cmds []*exec.Cmd
	for i := 0; i < procs; i++ {
		c := exec.Command(os.Args[0], "-test.run=^TestHelperMarkDone$")
		c.Env = append(os.Environ(), "STATE_HELPER_PATH="+p, fmt.Sprintf("STATE_HELPER_STEP=p%d", i))
		if err := c.Start(); err != nil {
			t.Fatal(err)
		}
		cmds = append(cmds, c)
	}
	for _, c := range cmds {
		if err := c.Wait(); err != nil {
			t.Fatal(err)
		}
	}
	SetPath(p)
	defer SetPath(DefaultPath)
	if got := len(DoneSteps()); got != procs*20 {
		t.Fatalf("lost updates: want %d done steps, got %d", procs*20, got)
	}
}
