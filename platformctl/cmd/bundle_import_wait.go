package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/stack"
)

// k3s imports the image archives in agent/images when it starts, but the
// node turns Ready before the large archive is done: on the offline test,
// platform-images-amd64.tar.zst was still importing when provision named the
// digest-pinned images, so ingress-nginx's controller and admission images
// were reported "not in the bundle" and could only be pulled from a registry
// the node cannot reach. Naming waits for k3s to report every archive.

// Seams for tests.
var (
	bundleImportArchives = func() []string {
		var out []string
		for _, pat := range []string{"*.tar", "*.tar.zst", "*.tar.gz", "*.tar.lz4"} {
			m, _ := filepath.Glob(filepath.Join(stack.DefaultPaths.K3sImages, pat))
			out = append(out, m...)
		}
		return out
	}
	// k3sImportLog is the log of the running k3s process (MainPID): earlier
	// runs' "Imported" lines must not count.
	k3sImportLog = func() string {
		pid, err := shell.Output("systemctl", "show", "-p", "MainPID", "--value", "k3s")
		pid = strings.TrimSpace(pid)
		if err != nil || pid == "" || pid == "0" {
			return ""
		}
		out, _ := shell.Output("journalctl", "_PID="+pid, "-o", "cat", "--no-pager")
		return out
	}
	// importCached reports whether k3s's conditional-import cache
	// (agent/images/.cache.json, see k3s.EnableImageImportCache) lists the
	// archive unchanged: k3s then skips it silently, with no "Imported" line.
	importCached        = archiveInImportCache
	bundleImportTimeout = 20 * time.Minute
	bundleImportPoll    = 10 * time.Second
	bundleImportNow     = time.Now
	bundleImportSleep   = time.Sleep
)

// pendingImports are the archives the log does not report as imported yet.
func pendingImports(archives []string, log string) []string {
	var pending []string
	for _, a := range archives {
		if !strings.Contains(log, "images from "+a+" in ") && !importCached(a) {
			pending = append(pending, filepath.Base(a))
		}
	}
	return pending
}

// archiveInImportCache reads k3s's import cache: an entry with the archive's
// size and an mtime not older than the file's means k3s imported this file.
func archiveInImportCache(archive string) bool {
	b, err := os.ReadFile(filepath.Join(filepath.Dir(archive), ".cache.json"))
	if err != nil || len(b) == 0 {
		return false
	}
	var cache map[string]struct {
		Size    int64     `json:"size"`
		ModTime time.Time `json:"modTime"`
		Images  []string  `json:"images"`
	}
	if json.Unmarshal(b, &cache) != nil {
		return false
	}
	e, ok := cache[archive]
	fi, err := os.Stat(archive)
	return ok && err == nil && e.Images != nil && e.Size == fi.Size() && !fi.ModTime().After(e.ModTime)
}

// waitBundleImports waits until k3s has imported every staged archive, or the
// timeout passes (then naming proceeds and reports what is missing).
func waitBundleImports() {
	archives := bundleImportArchives()
	if len(archives) == 0 {
		return
	}
	deadline := bundleImportNow().Add(bundleImportTimeout)
	announced := false
	for {
		pending := pendingImports(archives, k3sImportLog())
		if len(pending) == 0 {
			if announced {
				color.Green("  ✓ k3s imported the bundle's images")
			}
			return
		}
		if bundleImportNow().After(deadline) {
			color.Yellow("  ⚠ k3s has not finished importing %s after %s", strings.Join(pending, ", "), bundleImportTimeout)
			return
		}
		if !announced {
			fmt.Fprintf(os.Stdout, "  ■ Waiting for k3s to import %s (large archives take several minutes)...\n", strings.Join(pending, ", "))
			announced = true
		}
		bundleImportSleep(bundleImportPoll)
	}
}
