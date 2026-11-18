package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/diagnostics"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/license"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func stubDiagnostics(t *testing.T, codes map[string]int) (*licenseFake, *bytes.Buffer) {
	t.Helper()
	f := stubLicense(t, false, codes, "")
	var out bytes.Buffer
	oldOut, oldPinned, oldComp, oldK8s, oldOS, oldUp, oldDiag, oldRole, oldDeadline :=
		diagOut, diagPinned, diagComponents, diagKubernetes, diagOSRelease, diagUptime, cfg.Diagnostics, joinedRole, diagDeadline
	oldVersion, oldArch, oldNow, oldProfile := diagVersion, diagArch, diagNow, cfg.Profile
	t.Cleanup(func() {
		diagOut, diagPinned, diagComponents, diagKubernetes, diagOSRelease, diagUptime, cfg.Diagnostics, joinedRole, diagDeadline =
			oldOut, oldPinned, oldComp, oldK8s, oldOS, oldUp, oldDiag, oldRole, oldDeadline
		diagVersion, diagArch, diagNow, cfg.Profile = oldVersion, oldArch, oldNow, oldProfile
		state.ResetTimings()
	})
	diagOut = &out
	diagPinned = func() bool { return false }
	diagComponents = func() []diagnostics.Component {
		return []diagnostics.Component{{Name: "Platform API", Status: diagnostics.ComponentHealthy}}
	}
	diagVersion = func() string { return "1.2.0" }
	diagArch = func() string { return "amd64" }
	diagNow = func() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) }
	cfg.Profile = "standard"
	diagKubernetes = func() string { return "v1.37.2+k3s1" }
	diagOSRelease = func() string { return "Ubuntu 24.04.1 LTS" }
	diagUptime = func() int64 { return 42 }
	joinedRole = func() string { return "" }
	cfg.Diagnostics = true
	state.ResetTimings()
	// The client is installed by an earlier step in real runs.
	if _, err := licenseInstaller().Ensure(t.Context()); err != nil {
		t.Fatal(err)
	}
	return f, &out
}

func readReport(t *testing.T, f *licenseFake) (diagnostics.Payload, string) {
	t.Helper()
	b, err := os.ReadFile(f.report)
	if err != nil {
		t.Fatalf("no report sent: %v", err)
	}
	var p diagnostics.Payload
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return p, string(b)
}

func TestDiagnosticsSentAfterSuccess(t *testing.T) {
	f, out := stubDiagnostics(t, nil)
	state.RecordTiming(state.StepTiming{Step: "k3s", Start: time.Now(), Duration: 3 * time.Second, Status: "ok"})
	sendDiagnostics(diagnostics.KindProvision, nil)
	p, _ := readReport(t, f)
	want := diagnostics.Platform{Version: "1.2.0", Profile: "standard", NodeCount: 2, Arch: "amd64", OSRelease: "Ubuntu 24.04.1 LTS", K8sVersion: "v1.37.2+k3s1"}
	if p.Schema != 1 || p.Kind != diagnostics.KindProvision || p.Platform != want || p.UptimeSeconds != 42 || p.GeneratedAt != "2026-11-17T10:00:00Z" || p.Validate() != nil {
		t.Fatalf("payload %+v", p)
	}
	if len(p.Steps) != 1 || p.Steps[0].Seconds != 3 || len(p.Components) != 1 || len(p.Failures) != 0 {
		t.Fatalf("payload %+v", p)
	}
	if !strings.Contains(out.String(), "PLATFORM_DIAGNOSTICS=off") {
		t.Fatalf("no notice: %q", out.String())
	}
	if !strings.Contains(f.calls(t), "report --file ") {
		t.Fatal("report not called")
	}
}

func TestDiagnosticsOnFailureAreRedacted(t *testing.T) {
	f, _ := stubDiagnostics(t, nil)
	state.RecordTiming(state.StepTiming{Step: "routing", Start: time.Now(), Duration: time.Second, Status: "failed"})
	sendDiagnostics(diagnostics.KindUpgrade, errors.New("lookup api.acme-corp.io on 10.0.0.2:53: ADMIN_PASSWORD=hunter2 "+strings.Repeat("x", 500)))
	p, raw := readReport(t, f)
	if p.Kind != diagnostics.KindError || p.Operation != diagnostics.KindUpgrade || len(p.Failures) != 2 {
		t.Fatalf("payload %+v", p)
	}
	for _, leak := range []string{"acme-corp", "10.0.0.2", "hunter2"} {
		if strings.Contains(raw, leak) {
			t.Fatalf("leaked %s: %s", leak, raw)
		}
	}
	if n := len(p.Failures[1].Error); n > diagnostics.MaxErrorLen {
		t.Fatalf("error not capped: %d", n)
	}
}

func TestDiagnosticsOptOut(t *testing.T) {
	f, out := stubDiagnostics(t, nil)
	cfg.Diagnostics = false
	sendDiagnostics(diagnostics.KindUpdate, nil)
	if _, err := os.Stat(f.report); err == nil || strings.Contains(f.calls(t), "report") || out.Len() != 0 {
		t.Fatal("sent while opted out")
	}
}

func TestDiagnosticsSkippedWithoutClient(t *testing.T) {
	_, out := stubDiagnostics(t, nil)
	licenseInstaller = func() license.Installer { return license.Installer{Dest: t.TempDir() + "/none"} }
	sendDiagnostics(diagnostics.KindJoin, nil)
	if out.Len() != 0 {
		t.Fatalf("not silent: %q", out.String())
	}
}

func TestDiagnosticsFailureNeverPropagates(t *testing.T) {
	_, _ = stubDiagnostics(t, map[string]int{"report": 1})
	sendDiagnostics(diagnostics.KindProvision, nil) // must not panic or block

	diagComponents = func() []diagnostics.Component { panic("health check crashed") }
	sendDiagnostics(diagnostics.KindProvision, nil)

	diagDeadline = 50 * time.Millisecond
	diagComponents = func() []diagnostics.Component { time.Sleep(2 * time.Second); return nil }
	start := time.Now()
	sendDiagnostics(diagnostics.KindProvision, nil)
	if time.Since(start) > time.Second {
		t.Fatal("blocked past the deadline")
	}
}

func TestPeriodicDiagnosticsOnRefresh(t *testing.T) {
	f, _ := stubDiagnostics(t, nil)
	if err := runLicenseRefresh(&bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if p, _ := readReport(t, f); p.Kind != diagnostics.KindPeriodic {
		t.Fatalf("kind %s", p.Kind)
	}
}

func TestDiagnosticsSkippedForDevBuilds(t *testing.T) {
	f, out := stubDiagnostics(t, nil)
	diagVersion = func() string { return "dev" }
	sendDiagnostics(diagnostics.KindProvision, nil)
	if _, err := os.Stat(f.report); err == nil || out.Len() != 0 {
		t.Fatal("sent from a dev build")
	}
}

func TestDiagnosticsRejectedPayloadIsDebugOnly(t *testing.T) {
	_, out := stubDiagnostics(t, map[string]int{"report": 2})
	t.Setenv("PLATFORMCTL_DEBUG", "")
	sendDiagnostics(diagnostics.KindProvision, nil)
	if strings.Contains(out.String(), "rejected") {
		t.Fatalf("rejection shown outside debug: %q", out.String())
	}
}
