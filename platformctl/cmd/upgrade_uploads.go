package cmd

// Releases up to v1.2.0 stored SDK/portal uploads on the API container's
// filesystem (/app/uploads, no volume). They are lost whenever an API pod is
// replaced, including by the upgrade itself. Current releases store uploads in
// the bundled MinIO (or the default storage provider), so this only rescues
// what is left: before changing anything, upgrade archives /app/uploads of
// every API pod into the local backup directory and says where it is.

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// uploadsArchive streams a tar of /app/uploads in pod to w (tests replace it).
var uploadsArchive = func(pod string, w io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "kubectl", "-n", "platform", "exec", pod, "-c", "api", "--", "sh", "-c",
		`[ -d /app/uploads ] && [ -n "$(ls -A /app/uploads 2>/dev/null)" ] || exit 3; exec tar -C /app -cf - uploads`)
	c.Stdout = w
	var stderr strings.Builder
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 3 {
			return errNoUploads
		}
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

var errNoUploads = fmt.Errorf("no container-local uploads")

// backupContainerUploads archives container-local uploads of each API pod to
// <root>/uploads-<timestamp>/<pod>.tar. It never fails the upgrade: a pod that
// cannot be read is reported. Returns the archives written.
func backupContainerUploads(w io.Writer, root string) []string {
	if root == "" {
		root = "/var/lib/platform/backups"
	}
	raw, err := uk("-n", "platform", "get", "pods", "-l", "app=platform-api", "-o", "jsonpath={.items[*].metadata.name}")
	if err != nil {
		fmt.Fprintf(w, "WARNING: could not list API pods to back up container-local uploads: %v\n", err)
		return nil
	}
	dir := filepath.Join(root, "uploads-"+time.Now().UTC().Format("20060102T150405Z"))
	var out []string
	for _, pod := range strings.Fields(raw) {
		if err := os.MkdirAll(dir, 0700); err != nil {
			fmt.Fprintf(w, "WARNING: %v\n", err)
			return out
		}
		path := filepath.Join(dir, pod+".tar")
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			fmt.Fprintf(w, "WARNING: %v\n", err)
			continue
		}
		err = uploadsArchive(pod, f)
		cerr := f.Close()
		if err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(path)
			if err != errNoUploads {
				fmt.Fprintf(w, "WARNING: could not archive container-local uploads of %s: %v\n", pod, err)
			}
			continue
		}
		out = append(out, path)
	}
	if len(out) > 0 {
		fmt.Fprintf(w, "WARNING: uploads stored on the API container filesystem (releases up to v1.2.0) are lost when API pods are replaced. Archived before upgrading:\n")
		for _, p := range out {
			fmt.Fprintf(w, "  %s\n", p)
		}
		fmt.Fprintln(w, "  New uploads go to the bundled MinIO / default storage provider; see docs/operations/upgrades.md (\"Uploads stored in the API container\").")
	} else {
		os.Remove(dir)
	}
	return out
}
