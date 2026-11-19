package k3s

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ImageImportCache is k3s's conditional-import cache. k3s imports every image
// archive in agent/images before it starts the kubelet, on every start. On the
// 3-server ha test a joined server holds the whole platform stack there
// (~2.5 GB in 10 archives): after etcd lost quorum for a minute and k3s
// restarted, the kubelet came back 12.5 minutes later, so the PostgreSQL
// primary and an API pod on that server stayed down that long.
//
// When this file exists, k3s records each archive's size and mtime after the
// import and skips unchanged archives on the next start. An empty file enables
// it; k3s fills it in. Overridable in tests.
var ImageImportCache = filepath.Join(stackPaths.K3sImages, ".cache.json")

// EnableImageImportCache creates the empty cache file if it is missing (it
// never truncates an existing cache) and rounds the archives' mtimes down to
// whole seconds. k3s stores the mtime with second precision and re-imports a
// file whose mtime is after the stored one, so a sub-second mtime (any file
// platformctl downloads) would be re-imported on every start anyway.
// Runs before k3s starts on provision and join, and on re-runs.
func EnableImageImportCache() error {
	dir := filepath.Dir(ImageImportCache)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(ImageImportCache, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err == nil {
		err = f.Close()
	} else if errors.Is(err, fs.ErrExist) {
		err = nil
	}
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !isImageArchive(e.Name()) {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			return err
		}
		if mt := fi.ModTime(); !mt.Equal(mt.Truncate(time.Second)) {
			if err := os.Chtimes(filepath.Join(dir, e.Name()), mt.Truncate(time.Second), mt.Truncate(time.Second)); err != nil {
				return err
			}
		}
	}
	return nil
}

func isImageArchive(name string) bool {
	for _, ext := range []string{".tar", ".tar.zst", ".tar.gz", ".tar.lz4", ".tar.bz2"} {
		if strings.HasSuffix(name, ext) {
			return true
		}
	}
	return false
}
