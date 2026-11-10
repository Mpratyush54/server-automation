package upgrade

import (
	"io"
	"os"
	"path/filepath"
)

// InstallBinary atomically replaces the host executable after a successful
// transaction. The running process keeps its open inode until it exits.
func InstallBinary(src, dst string) error {
	if a, e := os.Stat(src); e == nil {
		if b, e := os.Stat(dst); e == nil && os.SameFile(a, b) {
			return nil
		}
	}
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	f, e := os.CreateTemp(filepath.Dir(dst), ".platformctl-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0755); e == nil {
		_, e = io.Copy(f, in)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e != nil {
		return e
	}
	return os.Rename(f.Name(), dst)
}
