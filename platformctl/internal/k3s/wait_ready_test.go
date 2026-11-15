package k3s

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// fakeK3s answers `k3s kubectl get node` like a server whose kubelet starts
// late: the API works at once, but for the first `empty` calls with
// --no-headers no node is listed or it is NotReady (k3s is still importing
// staged images; the server creates its Node object before the kubelet runs).
func fakeK3s(t *testing.T, empty int) (dir, counter string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs bash")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("needs bash")
	}
	dir = t.TempDir()
	counter = filepath.Join(dir, "calls")
	script := `#!/bin/bash
case " $* " in
  *" --no-headers "*)
    n=$(( $(cat "` + counter + `" 2>/dev/null || echo 0) + 1 )); echo "$n" > "` + counter + `"
    if [ "$n" -gt ` + strconv.Itoa(empty) + ` ]; then echo "node-1   Ready   control-plane   1m   v1"
    elif [ $((n % 2)) -eq 0 ]; then echo "node-1   NotReady   control-plane   1m   v1"; fi ;;
  *) echo "No resources found" >&2 ;;
esac
exit 0
`
	if err := os.WriteFile(filepath.Join(dir, "k3s"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir, counter
}

func TestWaitReadyScriptWaitsForAReadyNode(t *testing.T) {
	dir, counter := fakeK3s(t, 3)
	cmd := exec.Command("bash", "-c", waitReadyScript)
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "K3S_WAIT_INTERVAL=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("wait failed: %v\n%s", err, out)
	}
	b, _ := os.ReadFile(counter)
	if n, _ := strconv.Atoi(strings.TrimSpace(string(b))); n != 4 {
		t.Fatalf("returned after %d node listings, want 4 (3 without a Ready node, then Ready)", n)
	}
}

func TestWaitReadyScriptFailsWhenNoNodeBecomesReady(t *testing.T) {
	dir, _ := fakeK3s(t, 1<<30)
	cmd := exec.Command("bash", "-c", waitReadyScript)
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"), "K3S_WAIT_INTERVAL=0")
	out, err := cmd.CombinedOutput()
	if err == nil || !strings.Contains(string(out), "no node became Ready") {
		t.Fatalf("want a registration timeout, got err=%v\n%s", err, out)
	}
}
