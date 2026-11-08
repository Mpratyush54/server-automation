package bundle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// ReleaseBaseURL is the GitHub Releases download prefix. Tests override it.
var ReleaseBaseURL = "https://github.com/Mpratyush54/server-automation/releases/download"

// FileName returns the release asset name for a bundle.
func FileName(version, arch string) string {
	return fmt.Sprintf("platform-bundle-%s-%s.tar.zst", normalizeVersion(version), arch)
}

// URL returns the download URL of a bundle release asset.
func URL(version, arch string) string {
	v := normalizeVersion(version)
	return fmt.Sprintf("%s/%s/%s", strings.TrimSuffix(ReleaseBaseURL, "/"), v, FileName(v, arch))
}

// normalizeVersion turns "1.0.0" into the release tag form "v1.0.0".
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	if v != "" && v[0] >= '0' && v[0] <= '9' {
		return "v" + v
	}
	return v
}

// Fetch downloads the bundle for version/arch (e.g. "v1.0.0", "amd64") and its
// .sha256 into destDir, verifies the checksum and returns the bundle path.
// The .sha256 sidecar is kept next to the bundle so Install re-verifies it.
func Fetch(ctx context.Context, version, arch, destDir string) (string, error) {
	if version == "" || arch == "" {
		return "", fmt.Errorf("bundle: version and arch are required")
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", fmt.Errorf("bundle: create %s: %w", destDir, err)
	}
	url := URL(version, arch)
	dest := filepath.Join(destDir, FileName(version, arch))

	sumData, err := download(ctx, url+".sha256", io.Discard, 64<<10)
	if err != nil {
		return "", err
	}
	want, err := parseSidecar(sumData)
	if err != nil {
		return "", err
	}

	tmp, err := os.CreateTemp(destDir, ".bundle-download-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name()) // no-op after successful rename
	h := sha256.New()
	if err := downloadParts(ctx, url, io.MultiWriter(tmp, h)); err != nil {
		_ = tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
		return "", fmt.Errorf("bundle: checksum mismatch for downloaded %s (want %s, got %s)", FileName(version, arch), want, got)
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		return "", err
	}
	if err := os.WriteFile(dest+".sha256", sumData, 0o644); err != nil {
		return "", err
	}
	return dest, nil
}

// PartName is the name of split part i of a bundle file (".part00", ".part01", ...).
// GitHub release assets must be smaller than 2 GiB, and the bundle is larger,
// so releases carry it as parts (scripts/build-bundle.sh, `split -d -a 2`).
func PartName(file string, i int) string { return fmt.Sprintf("%s.part%02d", file, i) }

// errNotFound marks an HTTP 404, the end of the part sequence.
var errNotFound = errors.New("not found")

// downloadParts streams the bundle to w: its parts in order when the release
// has them, otherwise the single unsplit file. The caller verifies the
// checksum of the reassembled stream.
func downloadParts(ctx context.Context, url string, w io.Writer) error {
	_, err := download(ctx, PartName(url, 0), w, 0)
	if errors.Is(err, errNotFound) {
		_, err = download(ctx, url, w, 0) // unsplit bundle
		return err
	}
	if err != nil {
		return err
	}
	for i := 1; ; i++ {
		if _, err := download(ctx, PartName(url, i), w, 0); errors.Is(err, errNotFound) {
			return nil
		} else if err != nil {
			return err
		}
	}
}

// download GETs url. With limit > 0 the body (up to limit bytes) is returned
// instead of being streamed to w. An HTTP 404 wraps errNotFound; nothing is
// written to w unless the response is 200.
func download(ctx context.Context, url string, w io.Writer, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bundle: download %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("bundle: download %s: HTTP 404: %w", url, errNotFound)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bundle: download %s: HTTP %d", url, resp.StatusCode)
	}
	if limit > 0 {
		data, err := io.ReadAll(io.LimitReader(resp.Body, limit))
		if err != nil {
			return nil, fmt.Errorf("bundle: download %s: %w", url, err)
		}
		return data, nil
	}
	if _, err := io.Copy(w, resp.Body); err != nil {
		return nil, fmt.Errorf("bundle: download %s: %w", url, err)
	}
	return nil, nil
}
