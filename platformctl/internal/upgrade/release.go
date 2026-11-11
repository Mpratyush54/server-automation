package upgrade

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const Repository = "https://api.github.com/repos/Mpratyush54/server-automation"

type Release struct {
	Tag   string `json:"tag_name"`
	Notes string `json:"body"`
	Rules Rules  `json:"-"`
}

// PatchMetadata finds the newest stable patch in the source minor. On an
// outage it keeps the installed release, allowing the existing local images.
func PatchMetadata(current string) (Release, error) {
	source, e := Parse(current)
	if e != nil {
		return Release{}, e
	}
	b, e := get(Repository + "/releases?per_page=100")
	if e != nil {
		// Offline: stay on the installed release (local images keep working).
		return Release{Tag: "v" + strings.TrimPrefix(current, "v"), Notes: "GitHub release list unavailable; keeping the installed release."}, nil
	}
	var releases []struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if e = json.Unmarshal(b, &releases); e != nil {
		return Release{}, e
	}
	best := current
	vbest := source
	for _, r := range releases {
		v, e := Parse(r.Tag)
		if e == nil && !r.Draft && !r.Prerelease && v.Pre == "" && v.Major == source.Major && v.Minor == source.Minor && Compare(v, vbest) > 0 {
			best = r.Tag
			vbest = v
		}
	}
	return Metadata(best)
}

var client = &http.Client{Timeout: 60 * time.Second}

var errNotFound = errors.New("HTTP 404")

// AllowUnreleased accepts a --to release that is not published (testing a
// local build whose binary and images are already on the host).
var AllowUnreleased bool

func get(url string) ([]byte, error) {
	req, e := http.NewRequest("GET", url, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("GET %s: %w", url, errNotFound)
	}
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("GET %s: HTTP %d", url, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 128<<20))
}
func Metadata(target string) (Release, error) {
	endpoint := "/releases/latest"
	if target != "" {
		if _, e := Parse(target); e != nil {
			return Release{}, e
		}
		endpoint = "/releases/tags/v" + strings.TrimPrefix(target, "v")
	}
	b, e := get(Repository + endpoint)
	if e != nil {
		if target == "" {
			// The stable GHCR alias carries checksums with versioned asset names.
			sums, _, me := mirror("latest", "checksums.txt")
			if me != nil {
				return Release{}, fmt.Errorf("release metadata unavailable (%v); GHCR latest lookup: %w", e, me)
			}
			for _, line := range strings.Split(string(sums), "\n") {
				f := strings.Fields(line)
				if len(f) != 2 {
					continue
				}
				suffix := "_linux_" + runtime.GOARCH + ".tar.gz"
				if strings.HasPrefix(f[1], "platformctl_") && strings.HasSuffix(f[1], suffix) {
					v := strings.TrimSuffix(strings.TrimPrefix(f[1], "platformctl_"), suffix)
					parsed, pe := Parse(v)
					if pe == nil && parsed.Pre == "" {
						return Release{Tag: "v" + v, Notes: "GitHub release notes unavailable; using the stable GHCR release."}, nil
					}
				}
			}
			return Release{}, fmt.Errorf("no stable release version in GHCR checksums")
		}
		tag := "v" + strings.TrimPrefix(target, "v")
		// A typo in --to must not start an upgrade. 404 means the release does
		// not exist; on other errors (GitHub outage) the GHCR mirror must have it.
		if !errors.Is(e, errNotFound) {
			if _, _, me := mirror(strings.TrimPrefix(target, "v"), "checksums.txt"); me == nil {
				return Release{Tag: tag, Notes: "GitHub release notes unavailable; using the GHCR release mirror."}, nil
			}
		}
		if AllowUnreleased {
			return Release{Tag: tag, Notes: "UNRELEASED: no published release " + tag + " (--allow-unreleased); the target binary and images must already be on this host."}, nil
		}
		return Release{}, fmt.Errorf("release %s not found (%v); check --to, or pass --allow-unreleased to test a local build", tag, e)
	}
	var r Release
	if e = json.Unmarshal(b, &r); e != nil {
		return r, e
	}
	if _, e = Parse(r.Tag); e != nil {
		return r, e
	}
	b, e = get("https://github.com/Mpratyush54/server-automation/releases/download/" + r.Tag + "/upgrade.json")
	if e != nil {
		_, b, e = mirror(strings.TrimPrefix(r.Tag, "v"), "upgrade.json")
	}
	if e == nil {
		if e = json.Unmarshal(b, &r.Rules); e != nil {
			return r, fmt.Errorf("invalid upgrade.json: %w", e)
		}
	}
	return r, nil
}

// Download verifies the archive before reading any member; only the binary is extracted.
func Download(tag, dir string) (string, error) {
	if _, e := Parse(tag); e != nil {
		return "", e
	}
	if runtime.GOOS != "linux" {
		return "", fmt.Errorf("upgrades must run on the Linux platform host")
	}
	asset := fmt.Sprintf("platformctl_%s_linux_%s.tar.gz", strings.TrimPrefix(tag, "v"), runtime.GOARCH)
	base := "https://github.com/Mpratyush54/server-automation/releases/download/" + tag + "/"
	sums, se := get(base + "checksums.txt")
	archive, ae := get(base + asset)
	if se != nil || ae != nil {
		var e error
		sums, archive, e = mirror(strings.TrimPrefix(tag, "v"), asset)
		if e != nil {
			return "", e
		}
	}
	return extractVerified(asset, sums, archive, dir)
}

func extractVerified(asset string, sums, archive []byte, dir string) (string, error) {
	var expected string
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == asset {
			if expected != "" {
				return "", fmt.Errorf("duplicate checksum")
			}
			expected = f[0]
		}
	}
	sum := sha256.Sum256(archive)
	if len(expected) != 64 || !strings.EqualFold(expected, hex.EncodeToString(sum[:])) {
		return "", fmt.Errorf("release archive checksum mismatch")
	}
	gz, e := gzip.NewReader(strings.NewReader(string(archive)))
	if e != nil {
		return "", e
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, e := tr.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", e
		}
		if h.Name != "platformctl" {
			continue
		}
		if h.Typeflag != tar.TypeReg || h.Size > 128<<20 {
			return "", fmt.Errorf("invalid binary archive member")
		}
		p := filepath.Join(dir, "platformctl")
		f, e := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if e != nil {
			return "", e
		}
		_, e = io.Copy(f, tr)
		ce := f.Close()
		if e != nil {
			return "", e
		}
		return p, ce
	}
	return "", fmt.Errorf("platformctl missing in release archive")
}
func mirror(tag, asset string) ([]byte, []byte, error) {
	b, e := get("https://ghcr.io/token?scope=repository:mpratyush54/platformctl:pull")
	if e != nil {
		return nil, nil, e
	}
	var token struct {
		Token string `json:"token"`
	}
	if e = json.Unmarshal(b, &token); e != nil {
		return nil, nil, e
	}
	fetch := func(path string) ([]byte, error) {
		req, e := http.NewRequest("GET", "https://ghcr.io/v2/mpratyush54/platformctl/"+path, nil)
		if e != nil {
			return nil, e
		}
		req.Header.Set("Authorization", "Bearer "+token.Token)
		req.Header.Set("Accept", "application/vnd.oci.image.manifest.v1+json")
		res, e := client.Do(req)
		if e != nil {
			return nil, e
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return nil, fmt.Errorf("GHCR: HTTP %d", res.StatusCode)
		}
		return io.ReadAll(io.LimitReader(res.Body, 128<<20))
	}
	b, e = fetch("manifests/" + tag)
	if e != nil {
		return nil, nil, e
	}
	var m struct {
		Layers []struct {
			Digest      string
			Annotations map[string]string
		}
	}
	if e = json.Unmarshal(b, &m); e != nil {
		return nil, nil, e
	}
	files := map[string][]byte{}
	for _, l := range m.Layers {
		n := l.Annotations["org.opencontainers.image.title"]
		if n != asset && n != "checksums.txt" {
			continue
		}
		if !regexpDigest(l.Digest) {
			return nil, nil, fmt.Errorf("invalid GHCR layer digest")
		}
		data, e := fetch("blobs/" + l.Digest)
		if e != nil {
			return nil, nil, e
		}
		sum := sha256.Sum256(data)
		if l.Digest != "sha256:"+hex.EncodeToString(sum[:]) {
			return nil, nil, fmt.Errorf("GHCR layer checksum mismatch")
		}
		files[n] = data
	}
	if files[asset] == nil || files["checksums.txt"] == nil {
		return nil, nil, fmt.Errorf("release assets missing from GHCR mirror")
	}
	return files["checksums.txt"], files[asset], nil
}
func regexpDigest(s string) bool {
	if !strings.HasPrefix(s, "sha256:") || len(s) != 71 {
		return false
	}
	_, e := hex.DecodeString(s[7:])
	return e == nil
}
