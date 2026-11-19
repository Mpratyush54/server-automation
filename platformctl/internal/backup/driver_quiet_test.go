package backup

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

func fakeBash(t *testing.T, noise string, fail bool) {
	t.Helper()
	old := runBash
	t.Cleanup(func() { runBash = old })
	runBash = func(body string, args []string, stdout, stderr io.Writer) error {
		fmt.Fprint(stdout, noise)
		fmt.Fprint(stderr, "Defaulted container \"postgresql\"\n")
		if fail {
			return errors.New("exit status 1")
		}
		return nil
	}
}

func TestQuietCaptureShowsProgressNotRawOutput(t *testing.T) {
	fakeBash(t, "2026-11-19T00:00:00 writing admin.system.users to archive\n", false)
	var progress bytes.Buffer
	d := HostDriver{Quiet: true, Progress: &progress}
	if e := d.Capture("mongo", t.TempDir()); e != nil {
		t.Fatal(e)
	}
	got := progress.String()
	if !strings.Contains(got, "Backing up mongo") || !strings.Contains(got, "mongo done") {
		t.Fatalf("missing progress lines: %q", got)
	}
	if strings.Contains(got, "writing admin.system.users") || strings.Contains(got, "Defaulted container") {
		t.Fatalf("raw tool output leaked into progress: %q", got)
	}
}

func TestQuietScriptPrintsCapturedOutputOnFailure(t *testing.T) {
	fakeBash(t, "mongodump: connection refused\n", true)
	var errOut bytes.Buffer
	e := runScript("true", "mongo", t.TempDir(), true, &errOut)
	if e == nil {
		t.Fatal("expected failure")
	}
	got := errOut.String()
	if !strings.Contains(got, "--- mongo output ---") || !strings.Contains(got, "connection refused") || !strings.Contains(got, "Defaulted container") {
		t.Fatalf("failure output not shown: %q", got)
	}
}

func TestQuietScriptSuccessPrintsNothing(t *testing.T) {
	fakeBash(t, "lots of noise\n", false)
	var errOut bytes.Buffer
	if e := runScript("true", "postgres", t.TempDir(), true, &errOut); e != nil {
		t.Fatal(e)
	}
	if errOut.Len() != 0 {
		t.Fatalf("unexpected output: %q", errOut.String())
	}
}

func TestTailBufferKeepsTheEnd(t *testing.T) {
	b := &tailBuffer{max: 5}
	fmt.Fprint(b, "abc")
	fmt.Fprint(b, "defgh")
	if string(b.buf) != "defgh" {
		t.Fatalf("got %q", b.buf)
	}
}
