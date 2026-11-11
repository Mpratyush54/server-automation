package cmd

import (
	"bytes"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func planSteps(p []componentChange) map[string]componentChange {
	out := map[string]componentChange{}
	for _, c := range p {
		out[c.Step] = c
	}
	return out
}

// A v1.2.0 full install: database markers without fingerprints, no telemetry
// or synthetics. Upgrade must install the new components and reconcile the
// databases (listing their restarts), without re-running platform/seed.
func TestComponentPlanBringsOldInstallToProfile(t *testing.T) {
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	defer state.SetPath(state.DefaultPath)
	for _, m := range []string{"postgresql", "mongodb", "redis", "minio", "ingress", "cert-manager", "argocd", "monitoring", "portainer", "routing", "oauth2-proxy", "platform", "seed", "auto-update"} {
		if err := state.MarkDone(m); err != nil {
			t.Fatal(err)
		}
	}
	c := &config.Config{Profile: config.ProfileFull, InstallMonitoring: true, InstallArgoCD: true, InstallCertManager: true, InstallPortainer: true, AutoUpdate: true}
	p := planSteps(componentPlan(c))
	for _, db := range []string{"postgresql", "mongodb", "redis"} {
		if !strings.HasPrefix(p[db].Action, "reconcile") || p[db].Restarts == "" {
			t.Errorf("%s: %+v", db, p[db])
		}
	}
	for _, s := range []string{"telemetry", "synthetics"} {
		if p[s].Action != "install" {
			t.Errorf("%s: %+v", s, p[s])
		}
	}
	for _, s := range []string{"platform", "seed", "minio", "routing", "argocd", "auto-update"} {
		if _, ok := p[s]; ok {
			t.Errorf("%s re-run by the component reconcile", s)
		}
	}
	var buf bytes.Buffer
	printComponentPlan(&buf, "full", componentPlan(c))
	if !strings.Contains(buf.String(), "postgresql-0") || !strings.Contains(buf.String(), "telemetry") {
		t.Fatal(buf.String())
	}

	// After the reconcile: databases current, telemetry done -> only re-applies.
	for _, r := range components.DatabaseReleases(c) {
		_ = state.Set(r.Step+".values", r.Fingerprint())
	}
	_ = state.MarkDone("telemetry")
	_ = state.MarkDone("synthetics")
	for _, ch := range componentPlan(c) {
		if ch.Action != "re-apply" {
			t.Errorf("unexpected change after reconcile: %+v", ch)
		}
	}
}

// componentPlan runs steps in provisionGraph order: it must be topological.
func TestProvisionGraphOrderIsTopological(t *testing.T) {
	seen := map[string]bool{}
	c := &config.Config{Profile: config.ProfileFull}
	for _, s := range provisionGraph(c) {
		for _, d := range s.deps {
			if !seen[d] {
				t.Errorf("%s listed before its dependency %s", s.name, d)
			}
		}
		seen[s.name] = true
	}
}
