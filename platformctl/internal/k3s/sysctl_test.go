package k3s

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTuneHostWritesInotifyLimits(t *testing.T) {
	oldPath, oldApply := SysctlPath, applySysctl
	t.Cleanup(func() { SysctlPath, applySysctl = oldPath, oldApply })
	SysctlPath = filepath.Join(t.TempDir(), "sysctl.d", "90-platform-k8s.conf")
	applied := 0
	applySysctl = func(p string) error { applied++; return nil }
	if err := TuneHost(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(SysctlPath)
	if err != nil || !strings.Contains(string(b), "fs.inotify.max_user_instances = 8192") || applied != 1 {
		t.Fatalf("got %q, applied=%d, err=%v", b, applied, err)
	}
}
