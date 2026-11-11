// Package upgrade contains the release-independent upgrade transaction.
package upgrade

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Version struct {
	Major, Minor, Patch int
	Pre                 string
}

var versionRE = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$`)

func Parse(s string) (Version, error) {
	m := versionRE.FindStringSubmatch(s)
	if m == nil {
		return Version{}, fmt.Errorf("invalid release version %q; use vX.Y.Z", s)
	}
	a, ae := strconv.Atoi(m[1])
	b, be := strconv.Atoi(m[2])
	c, ce := strconv.Atoi(m[3])
	if ae != nil || be != nil || ce != nil {
		return Version{}, fmt.Errorf("release version is out of range")
	}
	if m[4] != "" {
		for _, part := range strings.Split(m[4][1:], ".") {
			if part == "" {
				return Version{}, fmt.Errorf("empty prerelease identifier")
			}
			numeric := true
			for _, ch := range part {
				if ch < '0' || ch > '9' {
					numeric = false
				}
			}
			if numeric && len(part) > 1 && part[0] == '0' {
				return Version{}, fmt.Errorf("numeric prerelease identifier has a leading zero")
			}
		}
	}
	return Version{a, b, c, m[4]}, nil
}
func Compare(a, b Version) int {
	for _, p := range [][2]int{{a.Major, b.Major}, {a.Minor, b.Minor}, {a.Patch, b.Patch}} {
		if p[0] < p[1] {
			return -1
		}
		if p[0] > p[1] {
			return 1
		}
	}
	if a.Pre == b.Pre {
		return 0
	}
	if a.Pre == "" {
		return 1
	}
	if b.Pre == "" {
		return -1
	}
	aa, bb := strings.Split(strings.TrimPrefix(a.Pre, "-"), "."), strings.Split(strings.TrimPrefix(b.Pre, "-"), ".")
	for i := 0; i < len(aa) && i < len(bb); i++ {
		if aa[i] == bb[i] {
			continue
		}
		an, ae := strconv.Atoi(aa[i])
		bn, be := strconv.Atoi(bb[i])
		if ae == nil && be == nil {
			if an < bn {
				return -1
			}
			return 1
		}
		if ae == nil {
			return -1
		}
		if be == nil {
			return 1
		}
		if aa[i] < bb[i] {
			return -1
		}
		return 1
	}
	if len(aa) < len(bb) {
		return -1
	}
	return 1
}

type Rules struct {
	MinimumSource string `json:"minimumSource,omitempty"`
	BreakingNotes string `json:"breakingNotes,omitempty"`
	Irreversible  bool   `json:"irreversibleMigrations,omitempty"`
}

func Compatible(from, to string, r Rules, patchOnly bool) error {
	a, e := Parse(from)
	if e != nil {
		return e
	}
	b, e := Parse(to)
	if e != nil {
		return e
	}
	if Compare(a, b) > 0 {
		return fmt.Errorf("downgrades are unsupported; restore a tested backup instead")
	}
	if b.Major > a.Major+1 || (r.MinimumSource == "" && b.Major != a.Major) {
		return fmt.Errorf("major upgrade needs release compatibility metadata; upgrade one supported major at a time")
	}
	if r.MinimumSource != "" {
		min, e := Parse(r.MinimumSource)
		if e != nil {
			return e
		}
		if Compare(a, min) < 0 {
			return fmt.Errorf("upgrade to %s first (minimum source)", r.MinimumSource)
		}
	}
	if patchOnly && (a.Major != b.Major || a.Minor != b.Minor || b.Pre != "") {
		return fmt.Errorf("automatic upgrades allow stable patches only")
	}
	return nil
}

type Chart struct {
	Name, Namespace, Chart, Version string
	Revision                        int
}
type Image struct{ Deployment, Container, Before, After string }
type Plan struct {
	Charts []Chart
	Images []Image
}

func Compute(installed []Chart, pins map[string]string, images []Image) Plan {
	p := Plan{}
	for _, c := range installed {
		if v, ok := pins[c.Chart]; ok && v != c.Version {
			c.Version = v
			p.Charts = append(p.Charts, c)
		}
	}
	for _, i := range images {
		if i.Before != i.After {
			p.Images = append(p.Images, i)
		}
	}
	return p
}

type Record struct {
	From, To, Backup, Status, Error string
	Started                         time.Time
	Plan                            Plan
}

func ReadHistory(path string) ([]Record, error) {
	b, e := os.ReadFile(path)
	if os.IsNotExist(e) {
		return []Record{}, nil
	}
	if e != nil {
		return nil, e
	}
	var r []Record
	e = json.Unmarshal(b, &r)
	return r, e
}
func AppendHistory(path string, r Record) ([]byte, error) {
	h, e := ReadHistory(path)
	if e != nil {
		return nil, e
	}
	h = append(h, r)
	b, e := json.MarshalIndent(h, "", "  ")
	if e != nil {
		return nil, e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return nil, e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".upgrade-*")
	if e != nil {
		return nil, e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e == nil {
		e = ce
	}
	if e == nil {
		e = os.Rename(f.Name(), path)
	}
	return b, e
}

// Hooks keep commands and host paths outside the transaction and injectable in tests.
type Hooks struct {
	Backup        func() (string, error)
	Migrate       func() error
	Chart         func(Chart) error
	Image         func(Image, bool) error
	RollbackChart func(Chart) error
	Health        func() error
	Save          func(Record) error
	// Commit persists the new release in the host configuration once the
	// health gate passed (optional). It must be atomic: when it fails nothing
	// was written, and the upgrade is rolled back like any other failure.
	Commit func() error
}

func Apply(r Record, h Hooks) (err error) {
	r.Started = time.Now().UTC()
	r.Status = "started"
	if e := h.Save(r); e != nil {
		return fmt.Errorf("persist upgrade intent: %w", e)
	}
	var charts []Chart
	var images []Image
	defer func() {
		if err != nil {
			r.Status = "failed"
			r.Error = err.Error()
			var failures []string
			for i := len(images) - 1; i >= 0; i-- {
				if e := h.Image(images[i], true); e != nil {
					failures = append(failures, e.Error())
				}
			}
			for i := len(charts) - 1; i >= 0; i-- {
				if e := h.RollbackChart(charts[i]); e != nil {
					failures = append(failures, e.Error())
				}
			}
			if len(images)+len(charts) > 0 {
				if e := h.Health(); e != nil {
					failures = append(failures, e.Error())
				}
				if len(failures) == 0 {
					r.Status = "rolled-back"
				} else {
					err = fmt.Errorf("%w; rollback requires attention: %s", err, strings.Join(failures, "; "))
					r.Error = err.Error()
				}
			}
		}
		if e := h.Save(r); e != nil {
			err = fmt.Errorf("upgrade result %s (%v); persist history: %w", r.Status, err, e)
		}
	}()
	r.Backup, err = h.Backup()
	if err != nil {
		return fmt.Errorf("backup failed; no changes applied: %w", err)
	}
	if err = h.Save(r); err != nil {
		return err
	}
	if err = h.Migrate(); err != nil {
		return fmt.Errorf("migration failed; database NOT restored automatically: %w", err)
	}
	for _, c := range r.Plan.Charts {
		charts = append(charts, c)
		if err = h.Chart(c); err != nil {
			return err
		}
	}
	for _, i := range r.Plan.Images {
		images = append(images, i)
		if err = h.Image(i, false); err != nil {
			return err
		}
	}
	if err = h.Health(); err != nil {
		return fmt.Errorf("health gate: %w", err)
	}
	if h.Commit != nil {
		if err = h.Commit(); err != nil {
			return fmt.Errorf("persist upgraded configuration: %w", err)
		}
	}
	r.Status = "succeeded"
	return nil
}
