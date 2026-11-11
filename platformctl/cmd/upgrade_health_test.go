package cmd

import (
	"strings"
	"testing"
)

// Regression (found on a VM upgrading rc.2 -> rc.3): Argo CD runs under the
// /argocd root path, so probing "/" returned 404 and failed both the upgrade
// health gate and the post-rollback gate.
func TestUpgradeHealthProbesArgoHealthz(t *testing.T) {
	var argo string
	for _, p := range upgradeHealthProbes(true) {
		if strings.Contains(p.URL, "argocd-server") {
			argo = p.URL
		}
	}
	if argo != "http://argocd-server.argocd.svc.cluster.local/healthz" {
		t.Fatalf("argocd health URL = %q", argo)
	}
	for _, p := range upgradeHealthProbes(false) {
		if strings.Contains(p.URL, "argocd") {
			t.Fatalf("argocd probed although not installed: %v", p.URL)
		}
	}
}

// Regression: the rollback gate probed /api/health/ready, which v1.2.0 does
// not have, so every rollback to v1.2.0 "required attention". The gate must
// also exercise the schema (/api/health/schema) on releases that have it.
func TestUpgradeHealthProbesFallBackForOlderAPIs(t *testing.T) {
	got := map[string]string{}
	for _, p := range upgradeHealthProbes(false) {
		got[p.URL] = p.On404
	}
	if got[apiInternal+"/api/health/ready"] != apiInternal+"/api/health" {
		t.Fatalf("ready probe has no /api/health fallback: %v", got)
	}
	if v, ok := got[apiInternal+"/api/health/schema"]; !ok || v != "skip" {
		t.Fatalf("schema probe missing or not optional on old APIs: %v", got)
	}
	if got["http://platform-portal.platform.svc.cluster.local"] != "" {
		t.Fatal("portal probe must not accept 404")
	}
}

// The probe script itself, run with node when available.
func TestHealthProbeScriptSemantics(t *testing.T) {
	if !strings.Contains(healthProbeScript, `f==="skip"`) || !strings.Contains(healthProbeScript, "r.status!==200") {
		t.Fatal("probe script lost its 404 handling")
	}
}
