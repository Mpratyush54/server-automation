package components

import (
	"strings"
	"testing"
)

func TestACMESolverUsesClusterIPService(t *testing.T) {
	// Project namespaces set services.nodeports=0, so a NodePort solver Service is
	// refused and the challenge (and its solver pod) never completes.
	m := IssuersManifest("ops@example.com")
	if !strings.Contains(m, "ingressClassName: nginx\n          serviceType: ClusterIP\n") {
		t.Fatalf("ACME http01 solver must use a ClusterIP Service:\n%s", m)
	}
}
