package manifests

import (
	"os"
	"strings"
	"testing"
)

func TestAPIRBACIsDedicatedAndResourceScoped(t *testing.T) {
	embedded, err := Read("platform-api-rbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	declarative, err := os.ReadFile("../../../k8s/platform/api-rbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.ReplaceAll(string(embedded), "\r\n", "\n") != strings.ReplaceAll(string(declarative), "\r\n", "\n") {
		t.Fatal("installer and GitOps RBAC diverged")
	}
	rbac := string(embedded)
	for _, bad := range []string{"cluster-admin", "name: default", "[\"*\"]", "pods/exec", "clusterrolebindings"} {
		if strings.Contains(rbac, bad) {
			t.Fatalf("excess permission %s", bad)
		}
	}
	for _, required := range []string{"kind: ServiceAccount", "name: platform-api", "resourceNames:", "platform-env", "platform-rotate-pending", "platform-credentials", "platform-oidc-signing-key", "namespace: databases", "namespace: argocd"} {
		if !strings.Contains(rbac, required) {
			t.Fatalf("missing scoped permission %s", required)
		}
	}
}

func TestLegacyBootstrapUsesSameAPIRBACAndPodIsolation(t *testing.T) {
	b, err := os.ReadFile("../../../platform-bootstrap/bootstrap-legacy.sh")
	if os.IsNotExist(err) {
		t.Skip("legacy bootstrap removed")
	}
	if err != nil {
		t.Fatal(err)
	}
	source := strings.ReplaceAll(string(b), "\r\n", "\n")
	embedded, err := Read("platform-api-rbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	// Normalise line endings: Windows checkouts embed CRLF.
	rbac := strings.TrimSpace(strings.ReplaceAll(string(embedded), "\r\n", "\n"))
	if !strings.Contains(source, "<<'RBAC'\n"+rbac+"\nRBAC") {
		t.Fatal("legacy bootstrap does not use scoped API RBAC")
	}
	for _, required := range []string{"serviceAccountName: platform-api", "automountServiceAccountToken: false", "runAsNonRoot: true", "allowPrivilegeEscalation: false", "drop: [\"ALL\"]", "containerPort: 8080", "targetPort: 8080", "SECRETS_ENCRYPTION_KEY=", "ADMIN_PASSWORD=", "deployment/platform-portal"} {
		if !strings.Contains(source, required) {
			t.Errorf("legacy bootstrap missing %s", required)
		}
	}
	if strings.Contains(source, "name: cluster-admin") {
		t.Fatal("legacy bootstrap grants cluster-admin")
	}
}

func TestAPILeaseRBACIsNamespaceScoped(t *testing.T) {
	embedded, err := Read("platform-api-rbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var leaseDocs []string
	for _, doc := range strings.Split(strings.ReplaceAll(string(embedded), "\r\n", "\n"), "\n---") {
		if strings.Contains(doc, "leases") {
			leaseDocs = append(leaseDocs, doc)
		}
	}
	if len(leaseDocs) != 1 {
		t.Fatalf("expected lease rules in exactly one manifest, got %d", len(leaseDocs))
	}
	doc := leaseDocs[0]
	if !strings.Contains(doc, "kind: Role\n") || !strings.Contains(doc, "namespace: platform\n") {
		t.Fatal("lease permissions must be a namespaced Role in the platform namespace, not a ClusterRole")
	}
	if !strings.Contains(doc, "resourceNames: [\"platform-api-leader\"]\n  verbs: [\"get\", \"update\"]") {
		t.Fatal("lease get/update must be limited to the platform-api-leader Lease")
	}
	for _, bad := range []string{"\"delete\"", "\"patch\"", "\"list\"", "\"watch\""} {
		if strings.Contains(doc, "leases\"]\n  verbs: ["+bad) {
			t.Fatalf("unexpected lease verb %s", bad)
		}
	}
}
