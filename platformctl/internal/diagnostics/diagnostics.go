// Package diagnostics builds and sends anonymous install diagnostics.
package diagnostics

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// EnvOptOut turns diagnostics off when set to off, false, no or 0.
const EnvOptOut = "PLATFORM_DIAGNOSTICS"

// Kinds.
const (
	KindProvision = "provision"
	KindUpdate    = "update"
	KindUpgrade   = "upgrade"
	KindJoin      = "join"
	KindPeriodic  = "periodic"
	KindError     = "error"
)

// MaxErrorLen caps each error summary.
const MaxErrorLen = 300

// Step is one timed step.
type Step struct {
	Step    string  `json:"step"`
	Seconds float64 `json:"seconds"`
	Status  string  `json:"status"`
}

// Failure is a failed step with a short summary.
type Failure struct {
	Step  string `json:"step"`
	Error string `json:"error"`
}

// Component is one health check result.
type Component struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// Payload is the diagnostics document.
type Payload struct {
	Kind          string      `json:"kind"`
	Operation     string      `json:"operation,omitempty"`
	Version       string      `json:"version"`
	Profile       string      `json:"profile"`
	Nodes         int         `json:"nodes"`
	Arch          string      `json:"arch"`
	OS            string      `json:"os"`
	Kubernetes    string      `json:"kubernetes"`
	UptimeSeconds int64       `json:"uptime_seconds"`
	Steps         []Step      `json:"steps"`
	Failures      []Failure   `json:"failures"`
	Components    []Component `json:"components"`
}

// Enabled reads the opt-out value.
func Enabled(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "off", "false", "no", "0":
		return false
	}
	return true
}

// StepsFrom converts step timings.
func StepsFrom(ts []state.StepTiming) []Step {
	out := make([]Step, 0, len(ts))
	for _, t := range ts {
		out = append(out, Step{Step: t.Step, Seconds: math.Round(t.Duration.Seconds()*10) / 10, Status: t.Status})
	}
	return out
}

// FailuresFrom lists failed steps; err (the command's error) is added as summary.
func FailuresFrom(ts []state.StepTiming, operation string, err error) []Failure {
	out := []Failure{}
	for _, t := range ts {
		if t.Status == "failed" {
			out = append(out, Failure{Step: t.Step})
		}
	}
	if err != nil {
		out = append(out, Failure{Step: operation, Error: err.Error()})
	}
	return out
}

// OSRelease returns PRETTY_NAME from an os-release file.
func OSRelease(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "PRETTY_NAME="); ok {
			return strings.Trim(v, `"'`)
		}
	}
	return ""
}

// Uptime returns seconds from /proc/uptime.
func Uptime(path string) int64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	f := strings.Fields(string(data))
	if len(f) == 0 {
		return 0
	}
	v, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0
	}
	return int64(v)
}

// Redacted returns a copy with every free-text field redacted and errors capped.
func (p Payload) Redacted() Payload {
	out := p
	out.OS = Redact(p.OS)
	out.Kubernetes = Redact(p.Kubernetes)
	out.Version = Redact(p.Version)
	out.Profile = Redact(p.Profile)
	out.Steps = make([]Step, len(p.Steps))
	for i, s := range p.Steps {
		s.Step, s.Status = Redact(s.Step), Redact(s.Status)
		out.Steps[i] = s
	}
	out.Failures = make([]Failure, len(p.Failures))
	for i, f := range p.Failures {
		out.Failures[i] = Failure{Step: Redact(f.Step), Error: Truncate(Redact(f.Error), MaxErrorLen)}
	}
	out.Components = make([]Component, len(p.Components))
	for i, c := range p.Components {
		out.Components[i] = Component{Name: Redact(c.Name), Status: Redact(c.Status)}
	}
	return out
}

// Truncate cuts s to at most n runes.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// Reporter runs the client's report command with the payload file.
type Reporter func(ctx context.Context, file string) error

// Timeout bounds one send.
const Timeout = 15 * time.Second

// Send redacts p, writes it to a 0600 temp file, calls report and removes the file.
func Send(ctx context.Context, p Payload, report Reporter) error {
	b, err := json.Marshal(p.Redacted())
	if err != nil {
		return err
	}
	f, err := os.CreateTemp("", "cairn-diagnostics-*.json")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	return report(ctx, name)
}
