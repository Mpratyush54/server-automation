package components

import (
	"strings"
	"testing"
)

// A provision interrupted during the Argo CD Helm step (servers joining
// mid-install) must not leave the next run stuck on a pending release.
func TestArgoCDInstallClearsStuckHelmLockFirst(t *testing.T) {
	s := argocdInstallScript("/tmp/argocd-values.yaml", "argo-cd --repo https://argoproj.github.io/argo-helm --version 1.0.0")
	lock := strings.Index(s, "clear_helm_lock argocd argocd")
	install := strings.Index(s, "helm upgrade --install argocd")
	if lock < 0 || install < 0 {
		t.Fatalf("script missing lock clear or install:\n%s", s)
	}
	if !strings.Contains(s, "clear_helm_lock() {") {
		t.Fatal("helm lock helper not defined in the script")
	}
	// The helper must be defined and called before any helm operation runs.
	if first := strings.Index(s, "if argocd_healthy; then"); first < lock {
		t.Fatal("lock must be cleared before the release is inspected")
	}
	for _, want := range []string{"-f /tmp/argocd-values.yaml", `ARGO_CHART="argo-cd --repo`, "pending-install|pending-upgrade|pending-rollback"} {
		if !strings.Contains(s, want) {
			t.Errorf("script missing %q", want)
		}
	}
	if strings.Contains(s, "%!") {
		t.Fatalf("format verbs leaked into the script:\n%s", s)
	}
}
