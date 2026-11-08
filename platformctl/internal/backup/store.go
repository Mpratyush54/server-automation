package backup

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Store publishes backup.json last: an interrupted upload is never listed or
// eligible for retention. Targets must be dedicated prefixes, never bucket roots
// containing unrelated data. mc reads credentials from its existing config.
type Store struct{ Target Target }

func runMC(args ...string) ([]byte, error) {
	c := exec.Command("mc", args...)
	var errout strings.Builder
	c.Stderr = &errout
	b, e := c.Output()
	if e != nil {
		return nil, fmt.Errorf("mc operation failed: %w", e)
	}
	return b, nil
}
func copyFile(src, dst string) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	if e = os.MkdirAll(filepath.Dir(dst), 0700); e != nil {
		return e
	}
	out, e := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	_, e = io.Copy(out, in)
	ce := out.Close()
	if e != nil {
		return e
	}
	return ce
}
func (s Store) object(id, file string) (string, error) {
	if !safeName.MatchString(id) || !safeName.MatchString(file) {
		return "", fmt.Errorf("invalid backup object name")
	}
	return s.Target.Path + "/" + id + "/" + file, nil
}
func (s Store) Put(id, file, src string) error {
	p, e := s.object(id, file)
	if e != nil {
		return e
	}
	if s.Target.Remote {
		_, e = runMC("cp", src, p)
		return e
	}
	return copyFile(src, p)
}
func (s Store) Get(id, file, dst string) error {
	p, e := s.object(id, file)
	if e != nil {
		return e
	}
	if s.Target.Remote {
		_, e = runMC("cp", p, dst)
		return e
	}
	return copyFile(p, dst)
}
func (s Store) List() ([]Manifest, error) {
	var ids []string
	if s.Target.Remote {
		b, e := runMC("ls", "--json", s.Target.Path+"/")
		if e != nil {
			return nil, e
		}
		dec := json.NewDecoder(strings.NewReader(string(b)))
		for dec.More() {
			var v struct {
				Key    string `json:"key"`
				Type   string `json:"type"`
				Status string `json:"status"`
			}
			if e = dec.Decode(&v); e != nil {
				return nil, e
			}
			if v.Status == "error" {
				return nil, fmt.Errorf("list target failed")
			}
			if v.Type == "folder" {
				ids = append(ids, strings.TrimSuffix(v.Key, "/"))
			}
		}
	} else {
		entries, e := os.ReadDir(s.Target.Path)
		if os.IsNotExist(e) {
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		for _, v := range entries {
			if v.IsDir() {
				ids = append(ids, v.Name())
			}
		}
	}
	tmp, e := os.MkdirTemp("", "platform-backup-list-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(tmp)
	var result []Manifest
	for _, id := range ids {
		if !safeName.MatchString(id) {
			continue
		}
		f := filepath.Join(tmp, "backup.json")
		if e = s.Get(id, "backup.json", f); e != nil {
			continue
		} // incomplete upload
		m, e := ReadManifest(f)
		if e != nil {
			return nil, fmt.Errorf("backup %s: %w", id, e)
		}
		if m.ID != id {
			return nil, fmt.Errorf("manifest ID mismatch")
		}
		result = append(result, m)
	}
	return result, nil
}
func (s Store) Retain(r Retention) error {
	items, e := s.List()
	if e != nil {
		return e
	}
	ids, e := Prune(items, r)
	if e != nil {
		return e
	}
	for _, id := range ids {
		// Remove only manifest-declared objects, never recursively delete a target.
		for _, m := range items {
			if m.ID != id {
				continue
			}
			files := []string{}
			for _, a := range m.Artifacts {
				files = append(files, a.File)
			}
			files = append(files, "backup.json")
			for _, f := range files {
				p, e := s.object(id, f)
				if e != nil {
					return e
				}
				if s.Target.Remote {
					_, e = runMC("rm", p)
				} else {
					e = os.Remove(p)
				}
				if e != nil && !os.IsNotExist(e) {
					return e
				}
			}
			if !s.Target.Remote {
				_ = os.Remove(filepath.Join(s.Target.Path, id))
			}
		}
	}
	return nil
}
