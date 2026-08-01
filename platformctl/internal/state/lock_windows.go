//go:build !unix

package state

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// AcquireLock uses a PID file on non-Unix (dev/tests). Production provision is Linux.
func AcquireLock(owner string) (unlock func(), err error) {
	mu.Lock()
	defer mu.Unlock()

	if err := os.MkdirAll(dirOf(lockPath), 0755); err != nil && !os.IsExist(err) {
		// temp dirs may not be /etc/platform
		_ = os.MkdirAll(dirOf(lockPath), 0755)
	}
	if data, err := os.ReadFile(lockPath); err == nil {
		meta := strings.TrimSpace(string(data))
		if pid := ParsePIDFromLock(meta); pid > 0 && AlivePID(pid) {
			return nil, fmt.Errorf("another platformctl is already running (%s)\n  lock: %s", meta, lockPath)
		}
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0644)
	if err != nil {
		return nil, err
	}
	writeLockMeta(f, owner)
	lockFile = f
	return func() {
		mu.Lock()
		defer mu.Unlock()
		if lockFile != nil {
			_ = lockFile.Close()
			lockFile = nil
		}
		_ = os.Remove(lockPath)
	}, nil
}

func dirOf(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[:i]
	}
	return "."
}

// silence unused import on some toolchains
var _ = strconv.Itoa
