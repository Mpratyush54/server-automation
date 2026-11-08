// Package backup implements versioned, encrypted disaster-recovery archives.
package backup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

const FormatVersion = 1

var safeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

type Artifact struct {
	Component string `json:"component"`
	File      string `json:"file"`
	SHA256    string `json:"sha256"`
	Bytes     int64  `json:"bytes"`
}
type Manifest struct {
	Version         int        `json:"version"`
	ID              string     `json:"id"`
	CreatedAt       time.Time  `json:"createdAt"`
	PlatformVersion string     `json:"platformVersion"`
	Artifacts       []Artifact `json:"artifacts"`
}

func Checksum(file string) (string, int64, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return hex.EncodeToString(h.Sum(nil)), n, err
}
func (m Manifest) Validate() error {
	if m.Version != FormatVersion || !safeName.MatchString(m.ID) || m.CreatedAt.IsZero() || len(m.Artifacts) == 0 {
		return fmt.Errorf("invalid or unsupported backup manifest")
	}
	seen := map[string]bool{}
	for _, a := range m.Artifacts {
		switch a.Component {
		case "config", "postgres", "mongo", "redis", "minio", "k3s":
		default:
			return fmt.Errorf("unknown manifest component")
		}
		if !safeName.MatchString(a.Component) || a.File != a.Component+".tar.age" || a.Bytes <= 0 || seen[a.Component] {
			return fmt.Errorf("invalid or duplicate artifact")
		}
		b, e := hex.DecodeString(a.SHA256)
		if e != nil || len(b) != 32 {
			return fmt.Errorf("invalid checksum")
		}
		seen[a.Component] = true
	}
	return nil
}
func ReadManifest(file string) (Manifest, error) {
	var m Manifest
	f, e := os.Open(file)
	if e != nil {
		return m, e
	}
	defer f.Close()
	e = json.NewDecoder(io.LimitReader(f, 1<<20)).Decode(&m)
	if e != nil {
		return m, e
	}
	return m, m.Validate()
}

// Target uses an existing mc alias: s3://alias/bucket/prefix. Credentials never
// appear in a target URL. file:///absolute/path is explicitly local-only.
type Target struct {
	Remote bool
	Path   string
}

func ParseTarget(raw string) (Target, error) {
	u, e := url.Parse(raw)
	if e != nil {
		return Target{}, e
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Contains(raw, "\\") {
		return Target{}, fmt.Errorf("target must not contain credentials, query or fragment")
	}
	switch u.Scheme {
	case "s3":
		if !safeName.MatchString(u.Host) {
			break
		}
		p := strings.Trim(u.Path, "/")
		parts := strings.Split(p, "/")
		for _, s := range parts {
			if !safeName.MatchString(s) || s == "." || s == ".." {
				return Target{}, fmt.Errorf("invalid S3 target path")
			}
		}
		return Target{true, u.Host + "/" + p}, nil
	case "file":
		if u.Host == "" && strings.HasPrefix(u.Path, "/") && path.Clean(u.Path) != "/" {
			p := path.Clean(u.Path)
			if runtime.GOOS == "windows" && len(p) > 3 && p[0] == '/' && p[2] == ':' {
				p = p[1:]
			}
			return Target{false, filepath.FromSlash(p)}, nil
		}
	}
	return Target{}, fmt.Errorf("target must be s3://mc-alias/bucket/prefix or file:///absolute/path")
}

type Retention struct {
	Daily   int `json:"daily"`
	Weekly  int `json:"weekly"`
	Monthly int `json:"monthly"`
}

// Keep the newest backup in each of the newest N distinct UTC calendar days,
// ISO weeks and months; take the union. Input order does not affect selection.
func Prune(items []Manifest, r Retention) ([]string, error) {
	if r.Daily < 1 || r.Weekly < 0 || r.Monthly < 0 {
		return nil, fmt.Errorf("retention needs daily >= 1, weekly/monthly >= 0")
	}
	items = append([]Manifest(nil), items...)
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	keep := map[string]bool{}
	for tier, count := range []int{r.Daily, r.Weekly, r.Monthly} {
		buckets := map[string]bool{}
		for _, m := range items {
			t := m.CreatedAt.UTC()
			key := t.Format("2006-01-02")
			if tier == 1 {
				y, w := t.ISOWeek()
				key = fmt.Sprintf("%d-%02d", y, w)
			}
			if tier == 2 {
				key = t.Format("2006-01")
			}
			if !buckets[key] && len(buckets) < count {
				buckets[key] = true
				keep[m.ID] = true
			}
		}
	}
	var out []string
	for _, m := range items {
		if !keep[m.ID] {
			out = append(out, m.ID)
		}
	}
	return out, nil
}
