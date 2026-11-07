// Package bundle installs the optional offline bundle produced by
// scripts/build-bundle.sh (release asset platform-bundle-<ver>-<arch>.tar.zst).
//
// Bundle layout (all paths are flat, one directory level):
//
//	manifest.json                                versions + file list (informational)
//	SHA256SUMS                                   sha256sum output for every other file
//	k3s/k3s-airgap-images-<arch>.tar.zst         k3s airgap images
//	images/platform-images-<arch>.tar.zst        `docker save | zstd` of images.txt
//	charts/<name>-<version>.tgz                  helm pull output, one per pinned chart
//
// Install must run BEFORE k3s is installed/started: k3s auto-imports every
// *.tar / *.tar.zst found in /var/lib/rancher/k3s/agent/images/ at startup.
// Charts land in versions.ChartCacheDir, where versions.Chart.Ref() picks
// them up instead of contacting the remote repository.
package bundle

import (
	"archive/tar"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// K3sImagesDir is where k3s looks for airgap image tarballs to auto-import.
const K3sImagesDir = "/var/lib/rancher/k3s/agent/images"

// Options controls where bundle contents are extracted. Tests override the roots.
type Options struct {
	// ImagesDir receives k3s/* and images/* tarballs (default K3sImagesDir).
	ImagesDir string
	// ChartsDir receives charts/*.tgz (default versions.ChartCacheDir).
	ChartsDir string
}

// DefaultOptions returns the production destination roots.
func DefaultOptions() Options {
	return Options{ImagesDir: K3sImagesDir, ChartsDir: versions.ChartCacheDir}
}

// Install verifies and extracts the bundle at path into the default roots.
func Install(path string) error {
	return InstallWithOptions(path, DefaultOptions())
}

// InstallWithOptions verifies the bundle against <path>.sha256 when that file
// exists, then extracts it into opts' roots. Every extracted file is also
// checked against the bundle's internal SHA256SUMS when present.
func InstallWithOptions(bundlePath string, opts Options) error {
	if opts.ImagesDir == "" || opts.ChartsDir == "" {
		return errors.New("bundle: ImagesDir and ChartsDir must be set")
	}
	if err := verifySidecar(bundlePath); err != nil {
		return err
	}

	f, err := os.Open(bundlePath)
	if err != nil {
		return fmt.Errorf("bundle: open: %w", err)
	}
	defer f.Close()

	zr, err := zstd.NewReader(f)
	if err != nil {
		return fmt.Errorf("bundle: zstd: %w", err)
	}
	defer zr.Close()

	extracted := map[string]string{} // bundle-relative name → sha256 hex
	written := []string{}            // destination paths, for cleanup on failure
	var sums map[string]string

	fail := func(err error) error {
		for _, p := range written {
			_ = os.Remove(p)
		}
		return err
	}

	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fail(fmt.Errorf("bundle: read tar: %w", err))
		}

		name, err := cleanEntryName(hdr.Name)
		if err != nil {
			return fail(err)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			continue
		case tar.TypeReg:
		default:
			return fail(fmt.Errorf("bundle: unsupported entry type %q for %s (links are not allowed)", hdr.Typeflag, hdr.Name))
		}
		if name == "" {
			continue
		}

		if name == "SHA256SUMS" {
			sums, err = parseSums(tr)
			if err != nil {
				return fail(err)
			}
			continue
		}

		dest := destination(name, opts)
		if dest == "" {
			// manifest.json and anything unknown: not installed.
			if _, err := io.Copy(io.Discard, tr); err != nil {
				return fail(fmt.Errorf("bundle: read %s: %w", name, err))
			}
			continue
		}

		sum, err := writeFile(dest, tr)
		if err != nil {
			return fail(fmt.Errorf("bundle: extract %s: %w", name, err))
		}
		written = append(written, dest)
		extracted[name] = sum
	}

	if sums != nil {
		for name, got := range extracted {
			want, ok := sums[name]
			if !ok {
				return fail(fmt.Errorf("bundle: %s is not listed in SHA256SUMS", name))
			}
			if !strings.EqualFold(want, got) {
				return fail(fmt.Errorf("bundle: checksum mismatch for %s", name))
			}
		}
	}
	if len(extracted) == 0 {
		return errors.New("bundle: archive contained no images or charts")
	}
	return nil
}

// cleanEntryName normalises a tar entry name and rejects absolute paths and
// any ".." component (path traversal). Returns "" for the archive root.
func cleanEntryName(raw string) (string, error) {
	n := strings.ReplaceAll(raw, "\\", "/")
	if strings.HasPrefix(n, "/") || filepath.IsAbs(raw) || (len(n) > 1 && n[1] == ':') {
		return "", fmt.Errorf("bundle: absolute path in archive: %q", raw)
	}
	for _, part := range strings.Split(n, "/") {
		if part == ".." {
			return "", fmt.Errorf("bundle: path traversal in archive: %q", raw)
		}
	}
	n = path.Clean(n)
	n = strings.TrimPrefix(n, "./")
	if n == "." {
		return "", nil
	}
	return n, nil
}

// destination maps a cleaned bundle entry to its absolute install path, or ""
// when the entry is not installed. Only flat <dir>/<file> entries qualify.
func destination(name string, opts Options) string {
	dir, file := path.Split(name)
	dir = strings.TrimSuffix(dir, "/")
	if file == "" || strings.Contains(dir, "/") {
		return ""
	}
	switch dir {
	case "k3s", "images":
		if strings.HasSuffix(file, ".tar") || strings.HasSuffix(file, ".tar.zst") || strings.HasSuffix(file, ".tar.gz") {
			return filepath.Join(opts.ImagesDir, file)
		}
	case "charts":
		if strings.HasSuffix(file, ".tgz") {
			return filepath.Join(opts.ChartsDir, file)
		}
	}
	return ""
}

// writeFile atomically writes r to dest and returns the sha256 of the content.
func writeFile(dest string, r io.Reader) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".bundle-*")
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, h), r); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		_ = os.Remove(tmp.Name())
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// parseSums reads sha256sum-format lines ("<hex>  <name>" or "<hex> *<name>").
func parseSums(r io.Reader) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			return nil, fmt.Errorf("bundle: malformed SHA256SUMS line %q", line)
		}
		name := strings.TrimPrefix(strings.TrimPrefix(fields[1], "*"), "./")
		out[name] = fields[0]
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("bundle: read SHA256SUMS: %w", err)
	}
	return out, nil
}

// verifySidecar checks bundlePath against <bundlePath>.sha256 if it exists.
func verifySidecar(bundlePath string) error {
	data, err := os.ReadFile(bundlePath + ".sha256")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("bundle: read checksum file: %w", err)
	}
	want, err := parseSidecar(data)
	if err != nil {
		return err
	}
	got, err := fileSHA256(bundlePath)
	if err != nil {
		return fmt.Errorf("bundle: hash: %w", err)
	}
	if !strings.EqualFold(want, got) {
		return fmt.Errorf("bundle: checksum mismatch for %s (want %s, got %s)", filepath.Base(bundlePath), want, got)
	}
	return nil
}

func parseSidecar(data []byte) (string, error) {
	fields := strings.Fields(string(data))
	if len(fields) == 0 || len(fields[0]) != sha256.Size*2 {
		return "", errors.New("bundle: malformed .sha256 file")
	}
	if _, err := hex.DecodeString(fields[0]); err != nil {
		return "", errors.New("bundle: malformed .sha256 file")
	}
	return fields[0], nil
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
