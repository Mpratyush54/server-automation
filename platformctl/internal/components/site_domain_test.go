package components

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestNoOldSiteDomain keeps user-facing installer output and docs links on the
// current public site (cairnpaas.dev). The old host only redirects there.
func TestNoOldSiteDomain(t *testing.T) {
	root := filepath.Join("..", "..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(data), "platform.pratyushes.dev") {
			t.Errorf("%s still links platform.pratyushes.dev; use https://cairnpaas.dev", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
