//go:build unix

package state

import (
	"os"
	"syscall"
)

// withFileLock serialises state read-modify-write across processes. The
// in-process mutex is not enough: parallel provision runs each step as a
// separate platformctl child, and each child writes the shared state file.
func withFileLock(fn func() error) error {
	f, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return fn() // best effort (e.g. directory not yet created)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return fn()
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}
