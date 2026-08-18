//go:build unix

package state

import (
	"fmt"
	"os"
	"syscall"
)

// AcquireLock prevents concurrent provision/install runs using flock(2).
// `platformctl status` never calls this.
func AcquireLock(owner string) (unlock func(), err error) {
	mu.Lock()
	defer mu.Unlock()

	if err := os.MkdirAll("/etc/platform", 0755); err != nil {
		return nil, err
	}

	f, err := openExclusive(owner)
	if err != nil {
		return nil, err
	}

	lockFile = f
	return func() {
		mu.Lock()
		defer mu.Unlock()
		if lockFile != nil {
			_ = syscall.Flock(int(lockFile.Fd()), syscall.LOCK_UN)
			_ = lockFile.Close()
			lockFile = nil
		}
		_ = os.Remove(lockPath)
	}, nil
}

func openExclusive(owner string) (*os.File, error) {
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, err
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		prev, _ := readLockMeta(f)
		pid := ParsePIDFromLock(prev)
		_ = f.Close()
		if pid > 0 && !AlivePID(pid) {
			_ = os.Remove(lockPath)
			f2, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0644)
			if err != nil {
				return nil, err
			}
			if err := syscall.Flock(int(f2.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
				_ = f2.Close()
				return nil, fmt.Errorf("another platformctl is already running (lock: %s)", lockPath)
			}
			writeLockMeta(f2, owner)
			return f2, nil
		}
		if prev != "" {
			return nil, fmt.Errorf("another platformctl is already running (%s)\n  lock: %s\n  wait for it to finish, or remove the lock only if that process is dead", prev, lockPath)
		}
		return nil, fmt.Errorf("another platformctl is already running (lock: %s)", lockPath)
	}

	writeLockMeta(f, owner)
	return f, nil
}
