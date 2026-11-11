package cmd

import (
	"errors"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func TestUpgradeUnstampedBuild(t *testing.T) {
	oldVersion, oldHistory := Version, upgradeHistory
	defer func() { Version, upgradeHistory = oldVersion, oldHistory }()
	upgradeHistory = false
	for _, version := range []string{"dev", "", "e2e-abcdef", "invalid"} {
		Version = version
		err := runUpgrade(&cobra.Command{}, nil)
		const want = "this platformctl was not built as a release; install a release binary (install.sh) to use upgrade"
		if err == nil || err.Error() != want {
			t.Fatalf("version %q: got %v, want %q", version, err, want)
		}
	}
}

func TestUpgradeHealthyPods(t *testing.T) {
	for _, tt := range []struct {
		json string
		ok   bool
	}{
		{`{"items":[{"metadata":{"name":"api"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}]}`, true},
		{`{"items":[{"status":{"phase":"Succeeded"}}]}`, true},
		{`{"items":[{"metadata":{"name":"api"},"status":{"phase":"Running","conditions":[]}}]}`, false},
		{`{"items":[{"status":{"phase":"Pending"}}]}`, false}, {`not json`, false},
	} {
		if e := healthyPods([]byte(tt.json)); (e == nil) != tt.ok {
			t.Fatal(tt, e)
		}
	}
}

func TestLegacyUpdaterSuspensionAndSharedLockSchedule(t *testing.T) {
	old := upgradeRun
	defer func() { upgradeRun = old }()
	for _, tt := range []struct {
		raw       string
		wantCalls int
		ok        bool
	}{
		{``, 1, true},
		{`{"spec":{},"status":{"active":[{}]}}`, 1, false},
		{`{"spec":{"jobTemplate":{"spec":{"template":{"spec":{"containers":[{"command":["platformctl","upgrade","--patch-only","--yes"]}]}}}}},"status":{"active":[{}]}}`, 1, true},
		{`{"spec":{"suspend":false},"status":{}}`, 4, true},
	} {
		calls := 0
		upgradeRun = func(string, ...string) (string, error) { calls++; return tt.raw, nil }
		resume, e := suspendUpgradeUpdater()
		if (e == nil) != tt.ok {
			t.Fatal(e)
		}
		if e == nil {
			if e = resume(); e != nil {
				t.Fatal(e)
			}
		}
		if calls != tt.wantCalls {
			t.Fatal(calls, tt.wantCalls)
		}
	}
}

func TestUpgradePlanAndPreflightUseInjectedCommands(t *testing.T) {
	old := upgradeRun
	defer func() { upgradeRun = old }()
	upgradeRun = func(name string, args ...string) (string, error) {
		if name == "helm" {
			return `[{"name":"postgresql","namespace":"databases","chart":"postgresql-0.0.1","revision":"3"}]`, nil
		}
		return "ghcr.io/test/image@sha256:" + strings.Repeat("a", 64), nil
	}
	p, e := upgradePlan("ghcr.io/test/api@sha256:"+strings.Repeat("b", 64), "ghcr.io/test/image@sha256:"+strings.Repeat("a", 64))
	if e != nil || len(p.Charts) != 1 || len(p.Images) != 1 || p.Charts[0].Revision != 3 {
		t.Fatal(p, e)
	}
	upgradeRun = func(string, ...string) (string, error) { return "1\n1", nil }
	if e = upgradePreflight(); e == nil || !strings.Contains(e.Error(), "2 GiB") {
		t.Fatal(e)
	}
	upgradeRun = func(string, ...string) (string, error) { return "", errors.New("offline") }
	if e = upgradePreflight(); e == nil {
		t.Fatal("expected failure")
	}
}

// Regression (v1.2.0 -> Phase 4 upgrade): release "loki" running chart
// loki-stack-2.10.3 was planned as an upgrade to the loki 6.x chart because
// "loki-" prefixes "loki-stack-". Charts must match by exact name.
func TestUpgradePlanMatchesChartNamesExactly(t *testing.T) {
	old := upgradeRun
	defer func() { upgradeRun = old }()
	digest := "ghcr.io/test/image@sha256:" + strings.Repeat("a", 64)
	upgradeRun = func(name string, args ...string) (string, error) {
		if name == "helm" {
			return `[{"name":"loki","namespace":"monitoring","chart":"loki-stack-2.10.3","revision":"1"},` +
				`{"name":"kube-prometheus","namespace":"monitoring","chart":"kube-prometheus-stack-1.0.0","revision":"2"}]`, nil
		}
		return digest, nil
	}
	p, e := upgradePlan(digest, digest)
	if e != nil {
		t.Fatal(e)
	}
	for _, c := range p.Charts {
		if c.Name == "loki" {
			t.Fatalf("loki-stack release planned as %s %s", c.Chart, c.Version)
		}
	}
	if len(p.Charts) != 1 || p.Charts[0].Chart != "kube-prometheus-stack" || p.Charts[0].Version != versions.Get("kube-prometheus-stack").Version {
		t.Fatalf("plan = %+v", p.Charts)
	}
}

// Regression: upgrade left PLATFORM_IMAGE_TAG at the old release in
// /etc/platform/.env, so `install telemetry` pulled non-existent images and
// `provision` would roll the API back.
func TestPersistUpgradedTagRewritesEnvAtomically(t *testing.T) {
	dir := t.TempDir()
	old := upgradeEnvFile
	upgradeEnvFile = filepath.Join(dir, ".env")
	defer func() { upgradeEnvFile = old }()
	if e := os.WriteFile(upgradeEnvFile, []byte("DOMAIN=x.test\nPLATFORM_IMAGE_TAG=1.2.0\nADMIN_EMAIL=a@x.test\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := persistUpgradedTag("v1.3.0"); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(upgradeEnvFile)
	if string(b) != "DOMAIN=x.test\nPLATFORM_IMAGE_TAG=1.3.0\nADMIN_EMAIL=a@x.test\n" {
		t.Fatalf("env = %q", b)
	}
	if e := persistUpgradedTag("latest; rm -rf /"); e == nil {
		t.Fatal("persisted an invalid tag")
	}
	if _, e := os.Stat(upgradeEnvFile + ".tmp"); !os.IsNotExist(e) {
		t.Fatal("temporary file left behind")
	}
}
