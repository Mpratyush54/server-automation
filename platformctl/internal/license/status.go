package license

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	ConfigMapName      = "platform-license-status"
	ConfigMapNamespace = "platform"
	ConfigMapKey       = "status.json"
)

// Status is the cached report read by `platformctl status` and the API.
type Status struct {
	Report
	Enforce   bool   `json:"enforce"`
	UpdatedAt string `json:"updated_at"`
}

// NewStatus stamps a report.
func NewStatus(r Report, enforce bool, now time.Time) Status {
	return Status{Report: r, Enforce: enforce, UpdatedAt: now.UTC().Format(time.RFC3339)}
}

// WriteStatus writes the status file atomically (0644).
func WriteStatus(path string, s Status) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ReadStatus reads the status file.
func ReadStatus(path string) (Status, error) {
	f, err := os.Open(path)
	if err != nil {
		return Status{}, err
	}
	defer f.Close()
	return ParseStatus(f)
}

// Public drops machine-specific fields.
func (s Status) Public() Status {
	s.InstallID, s.File = "", ""
	return s
}

// ConfigMap is the manifest the API reads.
func ConfigMap(s Status) (map[string]any, error) {
	b, err := json.Marshal(s.Public())
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name": ConfigMapName, "namespace": ConfigMapNamespace,
			"labels": map[string]string{"app.kubernetes.io/part-of": "platform"},
		},
		"data": map[string]string{ConfigMapKey: string(b)},
	}, nil
}

// Summary is a one-line description for status output.
func (s Status) Summary() string {
	parts := []string{orDash(s.Status)}
	if s.Plan != "" {
		p := s.Plan
		if s.Org != "" {
			p += " (" + s.Org + ")"
		}
		parts = append(parts, "plan "+p)
	}
	if s.MaxNodes != nil && *s.MaxNodes > 0 {
		parts = append(parts, fmt.Sprintf("up to %d nodes", *s.MaxNodes))
	}
	if s.ExpiresAt != "" {
		parts = append(parts, "expires "+s.ExpiresAt)
	}
	if s.LastCheckin != "" {
		parts = append(parts, "updated "+s.LastCheckin)
	}
	mode := "report only"
	if s.Enforce {
		mode = "enforced"
	}
	parts = append(parts, mode)
	return strings.Join(parts, ", ")
}
