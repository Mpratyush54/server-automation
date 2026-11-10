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
	for _, required := range []string{"kind: ServiceAccount", "name: platform-api", "resourceNames:", "platform-env", "platform-rotate-pending", "platform-credentials", "platform-oidc-signing-key", "namespace: databases", "namespace: argocd", "name: platform-namespace-baseline", "kind: ValidatingAdmissionPolicy", "name: platform-project-namespaces", "failurePolicy: Fail"} {
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

type rbacRule struct{ groups, resources, names, verbs string }

// rbacRules returns the rules of the RBAC object `kind`/`name` (and namespace,
// for Roles) as normalised one-line tuples, in file order.
func rbacRules(t *testing.T, manifest, kind, name, namespace string) []rbacRule {
	t.Helper()
	for _, doc := range strings.Split(strings.ReplaceAll(manifest, "\r\n", "\n"), "\n---") {
		if !strings.Contains(doc, "\nkind: "+kind+"\n") || !strings.Contains(doc, "\n  name: "+name+"\n") {
			continue
		}
		if namespace != "" && !strings.Contains(doc, "\n  namespace: "+namespace+"\n") {
			continue
		}
		var rules []rbacRule
		for _, line := range strings.Split(doc, "\n") {
			switch {
			case strings.HasPrefix(line, "- apiGroups: "):
				rules = append(rules, rbacRule{groups: strings.TrimPrefix(line, "- apiGroups: ")})
			case len(rules) > 0 && strings.HasPrefix(line, "  resources: "):
				rules[len(rules)-1].resources = strings.TrimPrefix(line, "  resources: ")
			case len(rules) > 0 && strings.HasPrefix(line, "  resourceNames: "):
				rules[len(rules)-1].names = strings.ReplaceAll(strings.TrimPrefix(line, "  resourceNames: "), " ", "")
			case len(rules) > 0 && strings.HasPrefix(line, "  verbs: "):
				rules[len(rules)-1].verbs = strings.TrimPrefix(line, "  verbs: ")
			}
		}
		return rules
	}
	t.Fatalf("%s %s/%s not found", kind, namespace, name)
	return nil
}

// TestAPIRBACIsExactlyTheWaveOneUnion pins the platform-api grants to what the
// API code uses: the pre-existing rules plus #19 (leader Lease), #20 (named
// config Secrets), #21 (backup status ConfigMaps) and #22 (namespace baseline).
// Anything broader must be added here deliberately.
func TestAPIRBACIsExactlyTheWaveOneUnion(t *testing.T) {
	embedded, err := Read("platform-api-rbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(embedded)
	expect := func(kind, name, ns string, want []rbacRule) {
		t.Helper()
		got := rbacRules(t, manifest, kind, name, ns)
		if len(got) != len(want) {
			t.Fatalf("%s %s/%s: %d rules, want %d: %+v", kind, ns, name, len(got), len(want), got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("%s %s/%s rule %d = %+v, want %+v", kind, ns, name, i, got[i], want[i])
			}
		}
	}
	expect("ClusterRole", "platform-api", "", []rbacRule{
		{`[""]`, `["namespaces"]`, "", `["get", "list", "create", "update"]`}, // #22 labels/PSA on project namespaces
		{`[""]`, `["nodes"]`, "", `["list"]`},
		{`[""]`, `["pods"]`, "", `["list", "delete"]`},
		{`[""]`, `["pods/log"]`, "", `["get"]`},
		{`[""]`, `["services"]`, "", `["list", "create", "update", "delete"]`},
		{`["apps"]`, `["deployments"]`, "", `["create", "update", "delete"]`},
		{`["networking.k8s.io"]`, `["ingresses"]`, "", `["get", "create", "update"]`},
		{`["rbac.authorization.k8s.io"]`, `["rolebindings"]`, "", `["get", "create", "update"]`},             // #22
		{`["rbac.authorization.k8s.io"]`, `["clusterroles"]`, `["platform-namespace-baseline"]`, `["bind"]`}, // #22
	})
	expect("Role", "platform-api", "platform", []rbacRule{
		{`[""]`, `["configmaps"]`, `["platform-backup-backup","platform-backup-restore-test"]`, `["get"]`}, // #21
		{`[""]`, `["secrets"]`, `["platform-env","platform-rotate-pending"]`, `["get", "update"]`},
		{`[""]`, `["secrets"]`, `["platform-credentials","platform-oidc-signing-key"]`, `["get", "update"]`}, // #20
		{`[""]`, `["secrets"]`, `["platform-rotate-pending"]`, `["delete"]`},
		{`["apps"]`, `["deployments"]`, `["platform-api"]`, `["patch"]`},
		{`[""]`, `["secrets"]`, "", `["create"]`},
		{`["coordination.k8s.io"]`, `["leases"]`, "", `["create"]`},                               // #19
		{`["coordination.k8s.io"]`, `["leases"]`, `["platform-api-leader"]`, `["get", "update"]`}, // #19
	})
	expect("Role", "platform-api", "databases", []rbacRule{
		{`[""]`, `["secrets"]`, `["postgresql","redis"]`, `["get", "update"]`},
	})
	expect("Role", "platform-api", "argocd", []rbacRule{
		{`[""]`, `["secrets"]`, `["argocd-secret","argocd-initial-admin-secret"]`, `["get", "update"]`},
		{`["argoproj.io"]`, `["applications"]`, "", `["get", "create", "update", "patch"]`},
	})
	expect("ClusterRole", "platform-namespace-baseline", "", []rbacRule{
		{`["networking.k8s.io"]`, `["networkpolicies"]`, "", `["get", "list", "create", "update"]`},
		{`[""]`, `["resourcequotas", "limitranges"]`, "", `["get", "list", "create", "update"]`},
		{`[""]`, `["pods", "services", "persistentvolumeclaims", "events"]`, "", `["list"]`}, // #31 topology
		{`["apps"]`, `["deployments", "replicasets"]`, "", `["list"]`},                      // #31 topology
		{`["networking.k8s.io"]`, `["ingresses"]`, "", `["list"]`},                          // #31 topology
		{`["cert-manager.io"]`, `["certificates"]`, "", `["list"]`},                         // #31 topology
	})
	if strings.Contains(manifest, "kind: ClusterRoleBinding\nmetadata:\n  name: platform-namespace-baseline") {
		t.Fatal("platform-namespace-baseline must only be bound per project namespace")
	}
}
