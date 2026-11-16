// Package diagnostics builds and sends anonymous install diagnostics (schema 1).
package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// EnvOptOut turns diagnostics off when set to off, false, no or 0.
const EnvOptOut = "PLATFORM_DIAGNOSTICS"

// Schema is the payload schema version.
const Schema = 1

// Kinds.
const (
	KindProvision = "provision"
	KindUpdate    = "update"
	KindUpgrade   = "upgrade"
	KindJoin      = "join"
	KindPeriodic  = "periodic"
	KindError     = "error"
)

// Limits.
const (
	MaxErrorLen   = 300
	MaxSteps      = 200
	MaxFailures   = 50
	MaxComponents = 100
	MaxNodes      = 10000
)

// Component statuses.
const (
	ComponentHealthy  = "healthy"
	ComponentDegraded = "degraded"
	ComponentDown     = "down"
	ComponentUnknown  = "unknown"
)

// Step is one timed step.
type Step struct {
	Step    string  `json:"step"`
	Seconds float64 `json:"seconds"`
	Status  string  `json:"status"`
}

// Failure is a failed step with a one-line summary.
type Failure struct {
	Step  string `json:"step"`
	Error string `json:"error"`
}

// Component is one health check result.
type Component struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// Platform describes the install.
type Platform struct {
	Version    string `json:"version"`
	Profile    string `json:"profile"`
	NodeCount  int    `json:"node_count"`
	Arch       string `json:"arch"`
	OSRelease  string `json:"os_release"`
	K8sVersion string `json:"k8s_version"`
}

// Payload is the diagnostics document.
type Payload struct {
	Schema        int         `json:"schema"`
	Kind          string      `json:"kind"`
	Operation     string      `json:"operation,omitempty"`
	GeneratedAt   string      `json:"generated_at"`
	Platform      Platform    `json:"platform"`
	UptimeSeconds int64       `json:"uptime_seconds"`
	Steps         []Step      `json:"steps"`
	Failures      []Failure   `json:"failures"`
	Components    []Component `json:"components"`
}

var (
	semverRe    = regexp.MustCompile(`^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$`)
	profileRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	osReleaseRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._()/+-]{0,63}$`)
	osBadChars  = regexp.MustCompile(`[^A-Za-z0-9 ._()/+-]+`)
	spaceRe     = regexp.MustCompile(`\s+`)
)

var (
	kinds      = map[string]bool{KindProvision: true, KindUpdate: true, KindUpgrade: true, KindJoin: true, KindPeriodic: true, KindError: true}
	operations = map[string]bool{KindProvision: true, KindUpdate: true, KindUpgrade: true, KindJoin: true}
	stepStates = map[string]bool{"ok": true, "failed": true, "skipped": true}
	compStates = map[string]bool{ComponentHealthy: true, ComponentDegraded: true, ComponentDown: true, ComponentUnknown: true}
	arches     = map[string]bool{"amd64": true, "arm64": true}
)

// IsSemver reports whether v is a release version.
func IsSemver(v string) bool { return semverRe.MatchString(v) }

// Enabled reads the opt-out value.
func Enabled(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "off", "false", "no", "0":
		return false
	}
	return true
}

// StepStatus maps a recorded step status onto ok, failed or skipped.
func StepStatus(s string) string {
	s = strings.ToLower(s)
	switch {
	case strings.Contains(s, "fail"), strings.Contains(s, "partial"):
		return "failed"
	case strings.Contains(s, "skip"), strings.Contains(s, "blocked"):
		return "skipped"
	}
	return "ok"
}

// StepsFrom converts step timings.
func StepsFrom(ts []state.StepTiming) []Step {
	out := make([]Step, 0, len(ts))
	for _, t := range ts {
		out = append(out, Step{Step: t.Step, Seconds: math.Round(t.Duration.Seconds()*10) / 10, Status: StepStatus(t.Status)})
	}
	return out
}

// FailuresFrom lists failed steps; err (the command's error) is added as summary.
func FailuresFrom(ts []state.StepTiming, operation string, err error) []Failure {
	out := []Failure{}
	for _, t := range ts {
		if StepStatus(t.Status) == "failed" {
			out = append(out, Failure{Step: t.Step, Error: "step failed"})
		}
	}
	if err != nil {
		out = append(out, Failure{Step: operation, Error: err.Error()})
	}
	return out
}

// Profile reduces p to the allowed profile characters.
func Profile(p string) string {
	p = strings.ToLower(strings.TrimSpace(p))
	if profileRe.MatchString(p) {
		return p
	}
	return "unknown"
}

// OSReleaseValue reduces s to the allowed os_release characters.
func OSReleaseValue(s string) string {
	s = strings.TrimSpace(spaceRe.ReplaceAllString(osBadChars.ReplaceAllString(s, " "), " "))
	s = strings.TrimLeft(s, " ._()/+-")
	s = strings.TrimSpace(Truncate(s, 64))
	if osReleaseRe.MatchString(s) {
		return s
	}
	return "unknown"
}

// K8sVersion returns v when it is a version, otherwise "".
func K8sVersion(v string) string {
	v = strings.TrimSpace(v)
	if IsSemver(v) {
		return v
	}
	return ""
}

// OneLine collapses whitespace and line breaks into single spaces.
func OneLine(s string) string { return strings.TrimSpace(spaceRe.ReplaceAllString(s, " ")) }

// OSRelease returns PRETTY_NAME from an os-release file.
func OSRelease(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "PRETTY_NAME="); ok {
			return strings.Trim(strings.TrimSpace(v), `"'`)
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

// Truncate cuts s to at most n runes.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// Sanitized returns a redacted copy that fits the schema limits and character sets.
func (p Payload) Sanitized() Payload {
	out := p
	out.Schema = Schema
	out.Platform.Profile = Profile(p.Platform.Profile)
	out.Platform.OSRelease = OSReleaseValue(p.Platform.OSRelease)
	out.Platform.K8sVersion = K8sVersion(p.Platform.K8sVersion)
	if out.Platform.NodeCount < 1 {
		out.Platform.NodeCount = 1
	}
	if out.Platform.NodeCount > MaxNodes {
		out.Platform.NodeCount = MaxNodes
	}
	if out.UptimeSeconds < 0 {
		out.UptimeSeconds = 0
	}
	if out.Kind != KindError {
		out.Operation = ""
	}
	out.Steps = []Step{}
	for _, s := range p.Steps {
		if len(out.Steps) == MaxSteps {
			break
		}
		if s.Seconds < 0 || math.IsNaN(s.Seconds) || math.IsInf(s.Seconds, 0) {
			s.Seconds = 0
		}
		out.Steps = append(out.Steps, Step{Step: nonEmpty(OneLine(Redact(s.Step)), "step"), Seconds: s.Seconds, Status: StepStatus(s.Status)})
	}
	out.Failures = []Failure{}
	for _, f := range p.Failures {
		if len(out.Failures) == MaxFailures {
			break
		}
		msg := strings.TrimSpace(Truncate(OneLine(Redact(f.Error)), MaxErrorLen))
		out.Failures = append(out.Failures, Failure{Step: nonEmpty(OneLine(Redact(f.Step)), "step"), Error: nonEmpty(msg, "failed")})
	}
	out.Components = []Component{}
	for _, c := range p.Components {
		if len(out.Components) == MaxComponents {
			break
		}
		status := c.Status
		if !compStates[status] {
			status = ComponentUnknown
		}
		out.Components = append(out.Components, Component{Name: nonEmpty(OneLine(Redact(c.Name)), "component"), Status: status})
	}
	return out
}

func validTime(s string) bool {
	_, err := time.Parse(time.RFC3339, s)
	return err == nil
}

// Validate checks a sanitized payload against schema 1.
func (p Payload) Validate() error {
	switch {
	case p.Schema != Schema:
		return errors.New("schema")
	case !kinds[p.Kind]:
		return errors.New("kind")
	case p.Kind == KindError && p.Operation != "" && !operations[p.Operation]:
		return errors.New("operation")
	case p.Kind != KindError && p.Operation != "":
		return errors.New("operation without error kind")
	case !validTime(p.GeneratedAt):
		return errors.New("generated_at")
	case !IsSemver(p.Platform.Version):
		return errors.New("platform.version")
	case !profileRe.MatchString(p.Platform.Profile):
		return errors.New("platform.profile")
	case p.Platform.NodeCount < 1 || p.Platform.NodeCount > MaxNodes:
		return errors.New("platform.node_count")
	case !arches[p.Platform.Arch]:
		return errors.New("platform.arch")
	case !osReleaseRe.MatchString(p.Platform.OSRelease):
		return errors.New("platform.os_release")
	case p.Platform.K8sVersion != "" && !IsSemver(p.Platform.K8sVersion):
		return errors.New("platform.k8s_version")
	case p.UptimeSeconds < 0:
		return errors.New("uptime_seconds")
	case p.Steps == nil || len(p.Steps) > MaxSteps:
		return errors.New("steps")
	case p.Failures == nil || len(p.Failures) > MaxFailures:
		return errors.New("failures")
	case p.Components == nil || len(p.Components) > MaxComponents:
		return errors.New("components")
	}
	for _, s := range p.Steps {
		if s.Step == "" || s.Seconds < 0 || !stepStates[s.Status] {
			return errors.New("steps[]")
		}
	}
	for _, f := range p.Failures {
		n := len([]rune(f.Error))
		if f.Step == "" || n < 1 || n > MaxErrorLen || strings.ContainsAny(f.Error, "\r\n") {
			return errors.New("failures[]")
		}
	}
	for _, c := range p.Components {
		if c.Name == "" || !compStates[c.Status] {
			return errors.New("components[]")
		}
	}
	return nil
}

// ErrInvalid is returned when the payload does not fit the schema.
var ErrInvalid = errors.New("diagnostics payload invalid")

// Reporter runs the client's report command with the payload file.
type Reporter func(ctx context.Context, file string) error

// Timeout bounds one send.
const Timeout = 15 * time.Second

// Send sanitizes and validates p, writes it to a 0600 temp file, calls report and removes the file.
func Send(ctx context.Context, p Payload, report Reporter) error {
	p = p.Sanitized()
	if err := p.Validate(); err != nil {
		return errors.Join(ErrInvalid, err)
	}
	b, err := json.Marshal(p)
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
