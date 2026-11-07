package cmd

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/runner"
)

func allOn() *config.Config {
	return &config.Config{
		InstallArgoCD: true, InstallMonitoring: true, InstallPortainer: true,
		InstallInfisical: true, InstallCertManager: true, AutoUpdate: true,
	}
}

func toNodes(steps []stepDef) []runner.Node {
	var nodes []runner.Node
	for _, s := range steps {
		nodes = append(nodes, runner.Node{Name: s.name, Deps: s.deps, Skip: s.skip,
			Run: func(context.Context) error { return nil }})
	}
	return nodes
}

func TestProvisionGraphValid(t *testing.T) {
	if err := runner.Validate(toNodes(provisionGraph(allOn()))); err != nil {
		t.Fatal(err)
	}
}

func TestProvisionGraphStepsAreInstallable(t *testing.T) {
	for _, s := range provisionGraph(allOn()) {
		if s.fn == nil {
			t.Errorf("%s: missing in-process fn", s.name)
		}
		if len(s.args) == 2 && s.args[0] == "install" && components.Find(s.args[1]) == nil {
			t.Errorf("%s: `platformctl install %s` is not a known component", s.name, s.args[1])
		}
	}
}

func TestProvisionGraphCriticalDeps(t *testing.T) {
	deps := map[string][]string{}
	for _, s := range provisionGraph(allOn()) {
		deps[s.name] = s.deps
	}
	must := map[string][]string{
		// Ingress-nginx's webhook rejects Ingress creates until it is ready.
		"routing":   {"ingress-nginx", "platform"},
		"platform":  {"postgresql", "mongodb", "redis", "minio"},
		"infisical": {"postgresql", "redis"},
		// Image Updater + Argo Application need ArgoCD's CRDs.
		"auto-update": {"argocd", "platform"},
		"seed":        {"platform"},
	}
	for step, want := range must {
		for _, d := range want {
			if !slices.Contains(deps[step], d) {
				t.Errorf("%s must depend on %s (has %v)", step, d, deps[step])
			}
		}
	}
}

func TestProvisionGraphHonoursToggles(t *testing.T) {
	c := allOn()
	c.InstallMonitoring, c.InstallArgoCD, c.AutoUpdate = false, false, false
	skipped := map[string]bool{}
	for _, s := range provisionGraph(c) {
		skipped[s.name] = s.skip
	}
	for _, n := range []string{"monitoring", "argocd", "auto-update"} {
		if !skipped[n] {
			t.Errorf("%s should be skipped", n)
		}
	}
	if skipped["platform"] || skipped["routing"] {
		t.Error("core steps must never be skipped")
	}
}

func TestChildEnvironPrefersSavedEnvFile(t *testing.T) {
	p := t.TempDir() + "/.env"
	if err := os.WriteFile(p, []byte("# comment\nDOMAIN=new.example.com\nJWT_SECRET=x\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := childEnviron([]string{"DOMAIN=old.example.com", "PATH=/usr/bin", childEnv + "=1"}, envFileKeys(p))
	if slices.Contains(env, "DOMAIN=old.example.com") {
		t.Error("stale inherited DOMAIN must be dropped so the child reads the saved file")
	}
	if !slices.Contains(env, "PATH=/usr/bin") {
		t.Error("unrelated variables must be kept")
	}
	if slices.Contains(env, childEnv+"=1") {
		t.Error("child marker must be added by runChild, not inherited")
	}
}

func TestResolveParallel(t *testing.T) {
	parallelFlag = 0
	t.Setenv("PLATFORMCTL_PARALLEL", "")
	if got := resolveParallel(); got != defaultParallel {
		t.Errorf("default: got %d", got)
	}
	t.Setenv("PLATFORMCTL_PARALLEL", "2")
	if got := resolveParallel(); got != 2 {
		t.Errorf("env: got %d", got)
	}
	parallelFlag = 6
	defer func() { parallelFlag = 0 }()
	if got := resolveParallel(); got != 6 {
		t.Errorf("flag: got %d", got)
	}
}
