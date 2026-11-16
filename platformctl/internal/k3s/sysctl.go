package k3s

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// SysctlPath holds the kernel limits a Kubernetes node needs. Overridable in tests.
var SysctlPath = "/etc/sysctl.d/90-platform-k8s.conf"

// HostSysctl raises the inotify limits. Ubuntu defaults to 128 inotify
// instances per user; on the 3-node ha test the node running most pods hit it
// and Alloy (log collection) crash-looped with "too many open files". The
// values match common Kubernetes node tuning.
const HostSysctl = `# Managed by platformctl: kernel limits for a Kubernetes node.
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches = 524288
`

// applySysctl loads the file; overridable in tests.
var applySysctl = func(path string) error {
	if out, err := shell.Output("sysctl", "-p", path); err != nil {
		return fmt.Errorf("sysctl -p %s: %w: %s", path, err, out)
	}
	return nil
}

// TuneHost writes and applies HostSysctl. It runs before k3s starts on
// provision and join, on every profile.
func TuneHost() error {
	if b, err := os.ReadFile(SysctlPath); err != nil || string(b) != HostSysctl {
		if err := os.MkdirAll(filepath.Dir(SysctlPath), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(SysctlPath, []byte(HostSysctl), 0o644); err != nil {
			return err
		}
	}
	return applySysctl(SysctlPath)
}
