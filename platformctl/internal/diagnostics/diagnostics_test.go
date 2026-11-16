package diagnostics

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func fullPayload() Payload {
	return Payload{
		Kind:          KindError,
		Operation:     KindUpgrade,
		GeneratedAt:   "2026-11-17T10:00:00Z",
		Platform:      Platform{Version: "v1.2.0", Profile: " HA ", NodeCount: 3, Arch: "amd64", OSRelease: `Ubuntu 24.04.1 LTS "Noble"`, K8sVersion: "v1.37.2+k3s1"},
		UptimeSeconds: 3600,
		Steps: []Step{
			{Step: "k3s", Seconds: 12.3, Status: "ok"},
			{Step: "chart-prefetch (background)", Seconds: 1, Status: "2 failed, using remote"},
			{Step: "image download", Seconds: 4, Status: "partial"},
			{Step: "longhorn", Seconds: 0, Status: "skipped"},
			{Step: "bundle", Seconds: 2, Status: "cached"},
		},
		Failures: []Failure{
			{Step: "routing", Error: "step failed"},
			{Step: "upgrade", Error: "lookup portal.acme.io on 10.0.0.2:53:\n  no such host\tADMIN_PASSWORD=hunter2"},
		},
		Components: []Component{{Name: "Platform API", Status: ComponentHealthy}, {Name: "ArgoCD", Status: "broken"}},
	}
}

const golden = `{"schema":1,"kind":"error","operation":"upgrade","generated_at":"2026-11-17T10:00:00Z",` +
	`"platform":{"version":"v1.2.0","profile":"ha","node_count":3,"arch":"amd64","os_release":"Ubuntu 24.04.1 LTS Noble","k8s_version":"v1.37.2+k3s1"},` +
	`"uptime_seconds":3600,` +
	`"steps":[{"step":"k3s","seconds":12.3,"status":"ok"},{"step":"chart-prefetch (background)","seconds":1,"status":"failed"},` +
	`{"step":"image download","seconds":4,"status":"failed"},{"step":"longhorn","seconds":0,"status":"skipped"},{"step":"bundle","seconds":2,"status":"ok"}],` +
	`"failures":[{"step":"routing","error":"step failed"},{"step":"upgrade","error":"lookup [host] on [ip]: no such host ADMIN_PASSWORD=[secret]"}],` +
	`"components":[{"name":"Platform API","status":"healthy"},{"name":"ArgoCD","status":"unknown"}]}`

func onlyKeys(t *testing.T, where string, v any, allowed ...string) {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("%s is not an object", where)
	}
	set := map[string]bool{}
	for _, k := range allowed {
		set[k] = true
	}
	for k := range m {
		if !set[k] {
			t.Errorf("%s: unknown field %q", where, k)
		}
	}
}

func TestGoldenPayloadMatchesSchema(t *testing.T) {
	p := fullPayload().Sanitized()
	if err := p.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != golden {
		t.Fatalf("payload:\n%s\nwant:\n%s", b, golden)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	onlyKeys(t, "root", m, "schema", "kind", "operation", "generated_at", "platform", "uptime_seconds", "steps", "failures", "components")
	if _, ok := m["counts"]; ok {
		t.Error("counts must be omitted")
	}
	onlyKeys(t, "platform", m["platform"], "version", "profile", "node_count", "arch", "os_release", "k8s_version")
	for _, s := range m["steps"].([]any) {
		onlyKeys(t, "steps[]", s, "step", "seconds", "status")
	}
	for _, f := range m["failures"].([]any) {
		onlyKeys(t, "failures[]", f, "step", "error")
	}
	for _, c := range m["components"].([]any) {
		onlyKeys(t, "components[]", c, "name", "status")
	}
}

func TestOperationOnlyWithErrorKind(t *testing.T) {
	p := fullPayload()
	p.Kind = KindPeriodic
	s := p.Sanitized()
	b, _ := json.Marshal(s)
	if s.Validate() != nil || strings.Contains(string(b), `"operation"`) {
		t.Fatalf("operation kept for kind periodic: %s", b)
	}
}

func TestValidateRejects(t *testing.T) {
	for name, mutate := range map[string]func(*Payload){
		"schema":       func(p *Payload) { p.Schema = 2 },
		"kind":         func(p *Payload) { p.Kind = "boot" },
		"operation":    func(p *Payload) { p.Operation = "periodic" },
		"time":         func(p *Payload) { p.GeneratedAt = "yesterday" },
		"dev version":  func(p *Payload) { p.Platform.Version = "dev" },
		"profile":      func(p *Payload) { p.Platform.Profile = "HA!" },
		"nodes":        func(p *Payload) { p.Platform.NodeCount = 0 },
		"arch":         func(p *Payload) { p.Platform.Arch = "386" },
		"os":           func(p *Payload) { p.Platform.OSRelease = "<b>" },
		"k8s":          func(p *Payload) { p.Platform.K8sVersion = "latest" },
		"step status":  func(p *Payload) { p.Steps[0].Status = "cached" },
		"error lines":  func(p *Payload) { p.Failures[0].Error = "a\nb" },
		"error empty":  func(p *Payload) { p.Failures[0].Error = "" },
		"error long":   func(p *Payload) { p.Failures[0].Error = strings.Repeat("x", 301) },
		"comp status":  func(p *Payload) { p.Components[0].Status = "ok" },
		"steps nil":    func(p *Payload) { p.Steps = nil },
		"too many":     func(p *Payload) { p.Failures = make([]Failure, MaxFailures+1) },
		"negative sec": func(p *Payload) { p.Steps[0].Seconds = -1 },
	} {
		p := fullPayload().Sanitized()
		mutate(&p)
		if p.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestSanitizeLimitsAndFallbacks(t *testing.T) {
	p := fullPayload()
	p.Platform.Profile = "!!"
	p.Platform.OSRelease = "@@@"
	p.Platform.K8sVersion = "unknown build"
	p.Platform.NodeCount = 50000
	p.Steps = make([]Step, 300)
	p.Failures = make([]Failure, 80)
	p.Components = make([]Component, 150)
	p.Failures[0].Error = strings.Repeat("é", 1000)
	s := p.Sanitized()
	if err := s.Validate(); err != nil {
		t.Fatal(err)
	}
	if s.Platform.Profile != "unknown" || s.Platform.OSRelease != "unknown" || s.Platform.K8sVersion != "" || s.Platform.NodeCount != MaxNodes {
		t.Fatalf("platform %+v", s.Platform)
	}
	if len(s.Steps) != MaxSteps || len(s.Failures) != MaxFailures || len(s.Components) != MaxComponents {
		t.Fatal("limits")
	}
	if len([]rune(s.Failures[0].Error)) != MaxErrorLen || s.Failures[1].Error != "failed" {
		t.Fatalf("errors %q", s.Failures[1].Error)
	}
	if Truncate("héllo", 2) != "hé" {
		t.Fatal("truncate is not rune-safe")
	}
}

func TestEnabled(t *testing.T) {
	for v, want := range map[string]bool{"": true, "on": true, "true": true, "off": false, "OFF": false, "false": false, "no": false, "0": false} {
		if Enabled(v) != want {
			t.Errorf("Enabled(%q) != %v", v, want)
		}
	}
}

func TestStepsAndFailures(t *testing.T) {
	ts := []state.StepTiming{
		{Step: "k3s", Duration: 1234 * time.Millisecond, Status: "ok"},
		{Step: "routing", Duration: time.Second, Status: "failed"},
	}
	steps := StepsFrom(ts)
	if len(steps) != 2 || steps[0].Seconds != 1.2 || steps[1].Status != "failed" {
		t.Fatalf("steps %+v", steps)
	}
	f := FailuresFrom(ts, "provision", errors.New("routing failed"))
	if len(f) != 2 || f[0].Step != "routing" || f[0].Error == "" || f[1].Error != "routing failed" {
		t.Fatalf("failures %+v", f)
	}
	if got := FailuresFrom(nil, "update", nil); got == nil || len(got) != 0 {
		t.Fatalf("empty failures %#v", got)
	}
}

func TestHostFiles(t *testing.T) {
	dir := t.TempDir()
	osr := filepath.Join(dir, "os-release")
	os.WriteFile(osr, []byte("NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n"), 0o644)
	if got := OSRelease(osr); got != "Ubuntu 24.04.1 LTS" {
		t.Fatalf("os %q", got)
	}
	up := filepath.Join(dir, "uptime")
	os.WriteFile(up, []byte("3600.52 7000.1\n"), 0o644)
	if Uptime(up) != 3600 || Uptime(filepath.Join(dir, "missing")) != 0 {
		t.Fatal("uptime")
	}
}

func TestSendWritesPrivateFileAndRemovesIt(t *testing.T) {
	var path string
	var body []byte
	err := Send(context.Background(), fullPayload(), func(ctx context.Context, file string) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("no timeout")
		}
		path = file
		if fi, err := os.Stat(file); err == nil && runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v", fi.Mode())
		}
		body, _ = os.ReadFile(file)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("temp file not removed")
	}
	if string(body) != golden {
		t.Fatalf("sent %s", body)
	}
}

func TestSendRefusesInvalidPayload(t *testing.T) {
	p := fullPayload()
	p.Platform.Version = "dev"
	called := false
	err := Send(context.Background(), p, func(context.Context, string) error { called = true; return nil })
	if !errors.Is(err, ErrInvalid) || called {
		t.Fatalf("err=%v called=%v", err, called)
	}
}
