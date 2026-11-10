package cmd

import (
	"strings"
	"testing"
)

// Regression (found on a VM upgrading rc.2 -> rc.3): Argo CD runs under the
// /argocd root path, so probing "/" returned 404 and failed both the upgrade
// health gate and the post-rollback gate.
func TestUpgradeHealthProbesArgoHealthz(t *testing.T) {
	urls := upgradeHealthURLs(true)
	var argo string
	for _, u := range urls {
		if strings.Contains(u, "argocd-server") {
			argo = u
		}
	}
	if argo != "http://argocd-server.argocd.svc.cluster.local/healthz" {
		t.Fatalf("argocd health URL = %q", argo)
	}
	for _, u := range upgradeHealthURLs(false) {
		if strings.Contains(u, "argocd") {
			t.Fatalf("argocd probed although not installed: %v", u)
		}
	}
}
