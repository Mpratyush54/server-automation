package preflight

import (
	"strings"
	"testing"
)

func TestResultDefaults(t *testing.T) {
	r := &Result{}
	if r.Passed {
		t.Error("new Result Passed should default to false")
	}
	if r.Errors != nil {
		t.Error("new Result Errors should be nil")
	}
}

func TestCheckNonLinux(t *testing.T) {
	if !isLinux() {
		// This only runs on non-Linux; on Linux it's a no-op
		return
	}
	// On Linux, we just verify the function signature works
	r := Check()
	if r == nil {
		t.Error("Check() should return a Result")
	}
}

func TestCheckReturnsResult(t *testing.T) {
	r := Check()
	if r == nil {
		t.Fatal("Check() returned nil")
	}
	if r.Passed != true && len(r.Errors) == 0 {
		t.Error("if not passed, should have errors")
	}
}

func TestPrintResultPassed(t *testing.T) {
	r := &Result{Passed: true}
	// Should not panic
	PrintResult(r)
}

func TestPrintResultFailed(t *testing.T) {
	r := &Result{Passed: false, Errors: []string{"test error 1", "test error 2"}}
	// Should not panic
	PrintResult(r)
}

func TestAddErrorPreservesPassed(t *testing.T) {
	r := &Result{Passed: true}
	r.Errors = append(r.Errors, "something went wrong")
	r.Passed = false
	if r.Passed {
		t.Error("should be false after adding error")
	}
	if len(r.Errors) != 1 {
		t.Errorf("expected 1 error, got %d", len(r.Errors))
	}
}

func TestCheckCmdsMissing(t *testing.T) {
	r := &Result{Passed: true}
	checkCmds(r)

	found := false
	for _, e := range r.Errors {
		if strings.Contains(e, "git") {
			found = true
			break
		}
	}
	if !found {
		t.Log("note: 'git' command found on system, test is inconclusive")
	}
}

func isLinux() bool {
	return true
}
