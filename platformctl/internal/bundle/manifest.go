package bundle

import (
	"archive/tar"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/klauspost/compress/zstd"
)

// ManifestFile is where Install stages the bundle's manifest.json (in
// Options.StagingDir) when the bundle's SHA256SUMS covers it.
const ManifestFile = "bundle-manifest.json"

// maxManifest bounds how much of manifest.json is read.
const maxManifest = 16 << 20

// Manifest is the part of manifest.json platformctl uses.
type Manifest struct {
	Version string `json:"version"`
	Arch    string `json:"arch"`
	// PlatformImageTag is the PLATFORM_IMAGE_TAG of the Cairn images in the
	// bundle (the release tag without its "v"); empty in bundles without them.
	PlatformImageTag string `json:"platformImageTag"`
	// PlatformImages are the Cairn images in the bundle, pinned by digest
	// ("<registry>/platform-api:<tag>@sha256:..."). The archive stores them
	// under their tag; images.AliasDigestRefs adds the digest names.
	PlatformImages []string `json:"platformImages"`
}

var platformTagRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

func parseManifest(data []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return m, fmt.Errorf("bundle: manifest.json: %w", err)
	}
	if m.PlatformImageTag != "" && !platformTagRe.MatchString(m.PlatformImageTag) {
		return m, fmt.Errorf("bundle: manifest.json: invalid platformImageTag %q", m.PlatformImageTag)
	}
	return m, nil
}

// ReadManifest reads manifest.json from the bundle archive without extracting
// anything else. It stops at the manifest, which build-bundle.sh writes right
// after SHA256SUMS, so it is fast on a multi-GiB bundle. When SHA256SUMS lists
// the manifest, its checksum must match; Install verifies the whole bundle.
func ReadManifest(bundlePath string) (Manifest, error) {
	f, err := os.Open(bundlePath)
	if err != nil {
		return Manifest{}, fmt.Errorf("bundle: open: %w", err)
	}
	defer f.Close()
	zr, err := zstd.NewReader(f)
	if err != nil {
		return Manifest{}, fmt.Errorf("bundle: zstd: %w", err)
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	var sums map[string]string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return Manifest{}, errors.New("bundle: no manifest.json in the archive")
		}
		if err != nil {
			return Manifest{}, fmt.Errorf("bundle: read tar: %w", err)
		}
		name, err := cleanEntryName(hdr.Name)
		if err != nil {
			return Manifest{}, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		switch name {
		case "SHA256SUMS":
			if sums, err = parseSums(tr); err != nil {
				return Manifest{}, err
			}
		case "manifest.json":
			data, err := io.ReadAll(io.LimitReader(tr, maxManifest))
			if err != nil {
				return Manifest{}, fmt.Errorf("bundle: read manifest.json: %w", err)
			}
			if want := sums[name]; want != "" {
				got := sha256.Sum256(data)
				if !strings.EqualFold(want, hex.EncodeToString(got[:])) {
					return Manifest{}, errors.New("bundle: checksum mismatch for manifest.json")
				}
			}
			return parseManifest(data)
		}
	}
}

// ReadStagedManifest reads the manifest Install staged in stagingDir.
// ok is false when there is none (no bundle, or one from an older release).
func ReadStagedManifest(stagingDir string) (m Manifest, ok bool, err error) {
	data, err := os.ReadFile(filepath.Join(stagingDir, ManifestFile))
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, false, nil
	}
	if err != nil {
		return Manifest{}, false, fmt.Errorf("bundle: %w", err)
	}
	m, err = parseManifest(data)
	return m, err == nil, err
}
