package backup

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type Config struct {
	Target    string    `json:"target"`
	Recipient string    `json:"recipient"`
	Retention Retention `json:"retention"`
	// Explicit list avoids silently claiming backups for absent components.
	Components []string `json:"components"`
	MinioAlias string   `json:"minioAlias,omitempty"`
}
type Driver interface {
	Capture(component, dir string) error
	Restore(component, dir string) error
}

func (c Config) Validate() error {
	if c.MinioAlias != "" && !safeName.MatchString(c.MinioAlias) {
		return fmt.Errorf("invalid MinIO alias")
	}
	if _, e := ParseTarget(c.Target); e != nil {
		return e
	}
	if _, e := Prune(nil, c.Retention); e != nil {
		return e
	}
	if len(c.Components) == 0 {
		return fmt.Errorf("configure components explicitly")
	}
	seen := map[string]bool{}
	for _, v := range c.Components {
		switch v {
		case "config", "postgres", "mongo", "redis", "minio", "k3s":
		default:
			return fmt.Errorf("unknown component %q", v)
		}
		if seen[v] {
			return fmt.Errorf("duplicate component")
		}
		seen[v] = true
	}
	if !seen["config"] || !seen["postgres"] {
		return fmt.Errorf("config and postgres are required")
	}
	return nil
}
func ReadConfig(file string) (Config, error) {
	var c Config
	b, e := os.ReadFile(file)
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(b, &c)
	if e != nil {
		return c, e
	}
	return c, c.Validate()
}
func Create(c Config, version string, d Driver) (Manifest, error) {
	var m Manifest
	if e := c.Validate(); e != nil {
		return m, e
	}
	t, e := ParseTarget(c.Target)
	if e != nil {
		return m, e
	}
	s := Store{t}
	// Validate recipient before creating any plaintext material.
	if e = ValidateRecipient(c.Recipient); e != nil {
		return m, e
	}
	tmp, e := os.MkdirTemp("", "platform-backup-")
	if e != nil {
		return m, e
	}
	defer os.RemoveAll(tmp)
	m = Manifest{Version: FormatVersion, ID: time.Now().UTC().Format("20060102T150405.000000000Z"), CreatedAt: time.Now().UTC(), PlatformVersion: version}
	for _, component := range c.Components {
		dir := filepath.Join(tmp, component)
		if e = os.Mkdir(dir, 0700); e != nil {
			return m, e
		}
		if e = d.Capture(component, dir); e != nil {
			return m, fmt.Errorf("capture %s: %w", component, e)
		}
		file := component + ".tar.age"
		dest := filepath.Join(tmp, file)
		if e = EncryptDirectory(dir, dest, c.Recipient); e != nil {
			return m, e
		}
		hash, n, e := Checksum(dest)
		if e != nil {
			return m, e
		}
		if e = s.Put(m.ID, file, dest); e != nil {
			return m, e
		}
		m.Artifacts = append(m.Artifacts, Artifact{component, file, hash, n})
		if e = os.RemoveAll(dir); e != nil {
			return m, e
		}
	}
	b, e := json.MarshalIndent(m, "", "  ")
	if e != nil {
		return m, e
	}
	f := filepath.Join(tmp, "backup.json")
	if e = os.WriteFile(f, b, 0600); e != nil {
		return m, e
	}
	if e = s.Put(m.ID, "backup.json", f); e != nil {
		return m, e
	}
	return m, s.Retain(c.Retention)
}

// Quiescer is implemented by drivers that can stop platform writers for the
// duration of a logical restore and restart them afterwards.
type Quiescer interface {
	Quiesce() (resume func() error, err error)
}

// RestoreOrder applies data before config: data steps authenticate with the
// running (fresh) cluster's credentials and reset database users to the
// backed-up passwords; config then restores the matching Secrets and .env.
var RestoreOrder = []string{"postgres", "mongo", "redis", "minio", "config", "k3s"}

// Restore stages and authenticates EVERY selected artifact before touching live
// services. The identity is supplied by the caller, never persisted by us.
func Restore(target, id, component string, identity []byte, d Driver) error {
	return WithRestore(target, id, component, identity, func(m Manifest, dirs map[string]string) (err error) {
		// The k3s datastore is restored offline (k3s stopped): no cluster API.
		if q, ok := d.(Quiescer); ok && component != "k3s" {
			resume, e := q.Quiesce()
			if e != nil {
				return fmt.Errorf("quiesce platform: %w", e)
			}
			defer func() {
				if e := resume(); e != nil && err == nil {
					err = fmt.Errorf("resume platform: %w", e)
				}
			}()
		}
		for _, name := range RestoreOrder {
			// A fresh provision uses logical restore. Datastore replacement is
			// reserved for explicit, offline k3s disaster recovery.
			if component == "" && name == "k3s" {
				continue
			}
			if dir, ok := dirs[name]; ok {
				if e := d.Restore(name, dir); e != nil {
					return fmt.Errorf("restore %s: %w", name, e)
				}
			}
		}
		return nil
	})
}
func WithRestore(target, id, component string, identity []byte, apply func(Manifest, map[string]string) error) error {
	t, e := ParseTarget(target)
	if e != nil {
		return e
	}
	s := Store{t}
	tmp, e := os.MkdirTemp("", "platform-restore-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(tmp)
	f := filepath.Join(tmp, "backup.json")
	if e = s.Get(id, "backup.json", f); e != nil {
		return e
	}
	m, e := ReadManifest(f)
	if e != nil {
		return e
	}
	if m.ID != id {
		return fmt.Errorf("manifest ID mismatch")
	}
	dirs := map[string]string{}
	for _, a := range m.Artifacts {
		if component != "" && component != a.Component {
			continue
		}
		f := filepath.Join(tmp, a.File)
		if e = s.Get(id, a.File, f); e != nil {
			return e
		}
		h, n, e := Checksum(f)
		if e != nil {
			return e
		}
		if h != a.SHA256 || n != a.Bytes {
			return fmt.Errorf("checksum mismatch for %s", a.Component)
		}
		dir := filepath.Join(tmp, a.Component)
		if e = os.Mkdir(dir, 0700); e != nil {
			return e
		}
		if e = DecryptDirectory(f, dir, bytes.NewReader(identity)); e != nil {
			return e
		}
		dirs[a.Component] = dir
	}
	if len(dirs) == 0 {
		return fmt.Errorf("component not present in backup")
	}
	return apply(m, dirs)
}
