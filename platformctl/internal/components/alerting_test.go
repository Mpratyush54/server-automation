package components

import (
	"os"
	"strings"
	"testing"
)

func TestAlertingRBACManifestIsScoped(t *testing.T) {
	m := strings.ReplaceAll(readManifest(alertingRBACManifest), "\r\n", "\n")
	if m == "" {
		t.Fatal("alerting RBAC manifest missing from embedded data")
	}
	for _, want := range []string{
		"kind: Role\n", "kind: RoleBinding\n", "namespace: monitoring",
		"resources: [prometheusrules, alertmanagerconfigs]",
		"resourceNames: [platform-alerting-webhook]",
		"name: platform-api\n    namespace: platform",
	} {
		if !strings.Contains(m, want) {
			t.Fatalf("alerting RBAC missing %q", want)
		}
	}
	// Never cluster-wide and never broad secret reads.
	for _, bad := range []string{"ClusterRole", "\"*\"", "escalate", "bind", "patch"} {
		if strings.Contains(m, bad) {
			t.Fatalf("alerting RBAC must not contain %q", bad)
		}
	}
	secretRules := strings.Count(m, "resources: [secrets]")
	if secretRules != 2 || strings.Contains(m, "resources: [secrets]\n    verbs: [get") {
		t.Fatal("secret access must be create-only or limited to platform-alerting-webhook")
	}
}

// The manifest is applied by the full-profile telemetry step only (one registration).
func TestAlertingRBACRegisteredInTelemetryStepOnly(t *testing.T) {
	src, err := os.ReadFile("telemetry.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(src), "alertingRBACManifest") != 1 {
		t.Fatal("alerting RBAC must be registered exactly once in InstallTelemetry")
	}
	components, err := os.ReadFile("components.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(components), alertingRBACManifest) {
		t.Fatal("alerting RBAC must not be applied by the standard install")
	}
}
