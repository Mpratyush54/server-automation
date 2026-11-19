package cmd

import (
	"errors"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/upgrade"
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

func TestUpgradeBackupToolsRefusesMissingSqlite(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	e := upgradeBackupTools(backup.Config{Target: "external", Components: []string{"k3s"}})
	if e == nil || !strings.Contains(e.Error(), "sqlite3") || !strings.Contains(e.Error(), "before the upgrade") {
		t.Fatal(e)
	}
}

func TestHeadroomErrorNamesTheShortResource(t *testing.T) {
	if e := headroomError(1994744, 8<<20); e == nil || !strings.Contains(e.Error(), "only 1947 MiB free under /var/lib") || strings.Contains(e.Error(), "RAM") {
		t.Fatal(e)
	}
	if e := headroomError(50<<20, 300*1024); e == nil || !strings.Contains(e.Error(), "only 300 MiB of RAM available") {
		t.Fatal(e)
	}
	if e := headroomError(2<<20, 512*1024); e != nil {
		t.Fatal(e)
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

func TestUpgradePlanMutableTagOnlyForUnreleasedTarget(t *testing.T) {
	old, oldOnNode := upgradeRun, upgradeImageOnNode
	defer func() { upgradeRun, upgradeImageOnNode, upgrade.AllowUnreleased = old, oldOnNode, false }()
	deployed := "ghcr.io/test/platform-api:1.3.0"
	upgradeRun = func(name string, args ...string) (string, error) {
		if name == "helm" {
			return "[]", nil
		}
		return deployed, nil
	}
	onNode := map[string]bool{deployed: true}
	upgradeImageOnNode = func(image string) bool { return onNode[image] }
	next := "ghcr.io/test/platform-api:1.3.1"
	if _, e := upgradePlan(deployed, deployed); e == nil {
		t.Fatal("mutable tag accepted without --allow-unreleased")
	}
	if _, e := upgradePlan(next, next); e == nil || !strings.Contains(e.Error(), "platformctl update") {
		t.Fatalf("local-build upgrade accepted without --allow-unreleased: %v", e)
	}
	upgrade.AllowUnreleased = true
	if _, e := upgradePlan(deployed, deployed); e != nil {
		t.Fatal(e)
	}
	// Local build -> next local build: the deployed tag is the rollback target.
	p, e := upgradePlan(next, next)
	if e != nil {
		t.Fatal(e)
	}
	if len(p.Images) != 2 || p.Images[0].Before != deployed || p.Images[0].After != next {
		t.Fatalf("plan images = %+v", p.Images)
	}
	if _, e := upgradePlan("ghcr.io/other/platform-api:1.3.1", next); e == nil {
		t.Fatal("a mutable tag from another repository accepted")
	}
	onNode[deployed] = false
	if _, e := upgradePlan(next, next); e == nil || !strings.Contains(e.Error(), "present on this node") {
		t.Fatalf("a rollback image missing from the node accepted: %v", e)
	}
}

func TestUnreleasedRollbackImageRepository(t *testing.T) {
	oldOnNode := upgradeImageOnNode
	defer func() { upgradeImageOnNode, upgrade.AllowUnreleased = oldOnNode, false }()
	upgradeImageOnNode = func(string) bool { return true }
	upgrade.AllowUnreleased = true
	for _, tt := range []struct {
		old, target string
		ok          bool
	}{
		{"localhost:5000/platform-api:1", "localhost:5000/platform-api:2", true},
		{"localhost:5000/platform-api:1", "localhost:5001/platform-api:2", false},
		{"ghcr.io/a/platform-api:1", "ghcr.io/a/platform-portal:2", false},
		{"ghcr.io/a/platform-api", "ghcr.io/a/platform-api:2", true},
	} {
		if got := unreleasedRollbackImage(tt.old, tt.target); got != tt.ok {
			t.Errorf("%s -> %s = %v", tt.old, tt.target, got)
		}
	}
}

// v1.2.0 installs run tag-only images: a release upgrade pins the rollback
// target to the digest the running pods report instead of refusing.
func TestUpgradePlanPinsTagOnlyImagesToTheRunningDigest(t *testing.T) {
	old := upgradeRun
	defer func() { upgradeRun = old }()
	d1 := "sha256:" + strings.Repeat("c", 64)
	d2 := "sha256:" + strings.Repeat("d", 64)
	target := "ghcr.io/test/platform-api:2.0.0@sha256:" + strings.Repeat("e", 64)
	var podIDs string
	upgradeRun = func(name string, args ...string) (string, error) {
		if name == "helm" {
			return "[]", nil
		}
		if len(args) > 3 && args[2] == "get" && args[3] == "pods" {
			return podIDs, nil
		}
		if strings.Contains(strings.Join(args, " "), "platform-portal") {
			return "ghcr.io/test/platform-portal:1.2.0", nil
		}
		return "ghcr.io/test/platform-api:1.2.0", nil
	}
	plan := func(ids string) (upgrade.Plan, error) {
		podIDs = ids
		return upgradePlan(target, target)
	}

	// Every pod reports the same digest of the same repository (api and portal queries share the stub).
	p, e := plan("ghcr.io/test/platform-api@" + d1 + "\nghcr.io/test/platform-api@" + d1 + "\n")
	if e == nil {
		t.Fatalf("portal pods report the api repository; must refuse: %+v", p)
	}
	upgradeRun2 := upgradeRun
	upgradeRun = func(name string, args ...string) (string, error) {
		if name == "kubectl" && len(args) > 5 && args[3] == "pods" {
			if strings.Contains(args[5], "platform-portal") {
				return "docker-pullable://ghcr.io/test/platform-portal@" + d2 + "\n", nil
			}
			return podIDs, nil
		}
		return upgradeRun2(name, args...)
	}
	p, e = plan("ghcr.io/test/platform-api@" + d1 + "\nghcr.io/test/platform-api@" + d1 + "\n")
	if e != nil {
		t.Fatal(e)
	}
	if p.Images[0].Before != "ghcr.io/test/platform-api:1.2.0@"+d1 || p.Images[1].Before != "ghcr.io/test/platform-portal:1.2.0@"+d2 {
		t.Fatalf("rollback targets = %+v", p.Images)
	}

	for name, ids := range map[string]string{
		"pods disagree (mid-rollout)": "ghcr.io/test/platform-api@" + d1 + "\nghcr.io/test/platform-api@" + d2,
		"another repository":          "ghcr.io/evil/platform-api@" + d1,
		"no digest":                   "ghcr.io/test/platform-api:1.2.0",
		"no pods":                     "",
	} {
		if _, e := plan(ids); e == nil || !strings.Contains(e.Error(), "platformctl update") {
			t.Fatalf("%s: want the pin-first error, got %v", name, e)
		}
	}
}
