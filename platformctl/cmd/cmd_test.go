package cmd

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"testing"
)

func captureOutput(fn func()) string {
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	fn()

	w.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(r)
	os.Stdout = old
	return buf.String()
}

func TestVersionCommand(t *testing.T) {
	Version = "test-version"
	output := captureOutput(func() {
		versionCmd.Run(nil, nil)
	})
	if !strings.Contains(output, "platformctl test-version") {
		t.Errorf("expected version output, got %q", output)
	}
}

func TestVersionFormat(t *testing.T) {
	Version = "1.2.3"
	output := captureOutput(func() {
		versionCmd.Run(nil, nil)
	})
	expected := fmt.Sprintf("platformctl %s\n", Version)
	if output != expected {
		t.Errorf("expected %q, got %q", expected, output)
	}
}

func TestInstallNoArg(t *testing.T) {
	// install command requires exactly 1 arg
	err := installCmd.Args(installCmd, []string{})
	if err == nil {
		t.Error("expected error for install with no args")
	}
}

func TestInstallTooManyArgs(t *testing.T) {
	err := installCmd.Args(installCmd, []string{"a", "b"})
	if err == nil {
		t.Error("expected error for install with 2 args")
	}
}

func TestHelpOutput(t *testing.T) {
	output := captureOutput(func() {
		rootCmd.Help()
	})
	if !strings.Contains(output, "provision") {
		t.Error("help should mention 'provision'")
	}
	if !strings.Contains(output, "install") {
		t.Error("help should mention 'install'")
	}
	if !strings.Contains(output, "status") {
		t.Error("help should mention 'status'")
	}
	if !strings.Contains(output, "seed") {
		t.Error("help should mention 'seed'")
	}
	if !strings.Contains(output, "version") {
		t.Error("help should mention 'version'")
	}
}
