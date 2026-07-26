package shell

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestOutput(t *testing.T) {
	out, err := Output("go", "version")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.HasPrefix(out, "go version") {
		t.Errorf("expected 'go version...', got '%s'", out)
	}
}

func TestOutputEmpty(t *testing.T) {
	out, err := Output("go", "env", "GOROOT")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("expected non-empty output from go env GOROOT")
	}
}

func TestOutputTrim(t *testing.T) {
	out, err := Output("go", "version")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != strings.TrimSpace(out) {
		t.Error("output should be trimmed of whitespace")
	}
}

func TestExistsTrue(t *testing.T) {
	if !Exists("go") {
		t.Error("Exists('go') should be true")
	}
}

func TestExistsFalse(t *testing.T) {
	if Exists("nonexistent_cmd_xyz_123") {
		t.Error("Exists('nonexistent_cmd_xyz_123') should be false")
	}
}

func TestWriteFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.txt")
	content := "hello from shell"

	if err := WriteFile(path, content); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading file: %v", err)
	}
	if string(data) != content {
		t.Errorf("expected %q, got %q", content, string(data))
	}
}

func TestFileExists(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "exists.txt")
	missing := filepath.Join(dir, "missing.txt")

	os.WriteFile(existing, []byte("test"), 0644)

	if !FileExists(existing) {
		t.Error("FileExists should be true for existing file")
	}
	if FileExists(missing) {
		t.Error("FileExists should be false for missing file")
	}
}

func TestRunWithInput(t *testing.T) {
	input := "hello input"
	out, err := RunWithInput("go", []string{"env", "GOROOT"}, input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out == "" {
		t.Error("expected non-empty output")
	}
}

func TestAppendFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "append.txt")

	if err := WriteFile(path, "line1\n"); err != nil {
		t.Fatal(err)
	}
	if err := AppendFile(path, "line2\n"); err != nil {
		t.Fatal(err)
	}

	data, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 || lines[0] != "line1" || lines[1] != "line2" {
		t.Errorf("unexpected content: %q", string(data))
	}
}

func TestMkdirAll(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a", "b", "c")

	if err := MkdirAll(path); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat created dir: %v", err)
	}
	if !info.IsDir() {
		t.Error("expected directory")
	}
}

func TestRunBashNotAvailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	err := RunBash("echo hello")
	if err != nil {
		t.Errorf("RunBash failed: %v", err)
	}
}
