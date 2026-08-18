package cmd

import (
	"bytes"
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
	if !strings.Contains(output, "platformctl 1.2.3") {
		t.Errorf("expected version line, got %q", output)
	}
	if !strings.Contains(output, "default image tag:") {
		t.Errorf("expected default image tag line, got %q", output)
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
	if !strings.Contains(output, "update") {
		t.Error("help should mention 'update'")
	}
	if !strings.Contains(output, "recover") {
		t.Error("help should mention 'recover'")
	}
	if !strings.Contains(output, "backup") {
		t.Error("help should mention 'backup'")
	}
}
