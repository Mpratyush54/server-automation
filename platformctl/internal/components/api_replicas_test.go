package components

import (
	"os"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestAPIReplicasAtLeastOne(t *testing.T) {
	for in, want := range map[int]int{0: 1, -3: 1, 1: 1, 2: 2, 4: 4} {
		if got := apiReplicas(&config.Config{APIReplicas: in}); got != want {
			t.Errorf("apiReplicas(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestAPIPDBOnlyWithMultipleReplicas(t *testing.T) {
	single := apiPDBScript(1)
	if !strings.Contains(single, "delete pdb platform-api") || strings.Contains(single, "PodDisruptionBudget") {
		t.Fatalf("single replica must remove the PDB (it would block drains): %s", single)
	}
	multi := apiPDBScript(2)
	for _, want := range []string{"kind: PodDisruptionBudget", "minAvailable: 1", "app: platform-api", "policy/v1"} {
		if !strings.Contains(multi, want) {
			t.Errorf("PDB script missing %q", want)
		}
	}
}

func TestDeploymentReadyCheckComparesReadyToDesired(t *testing.T) {
	cmd := deploymentReadyCheck("platform", "platform-api")
	if strings.Contains(cmd, "1/1") {
		t.Fatal("health check must not hard-code a single replica")
	}
	for _, want := range []string{"readyReplicas", ".spec.replicas", "-n platform platform-api"} {
		if !strings.Contains(cmd, want) {
			t.Errorf("check missing %q: %s", want, cmd)
		}
	}
}

// The API Deployment manifest must carry the zero-downtime settings from issue #18.
func TestPlatformAPIManifestRolloutSettings(t *testing.T) {
	src, err := os.ReadFile("components.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	start := strings.Index(s, "  name: platform-api\n  namespace: platform\n  labels:")
	if start < 0 {
		start = strings.Index(s, "  name: platform-api\r\n  namespace: platform\r\n  labels:")
	}
	if start < 0 {
		t.Fatal("platform-api Deployment manifest not found")
	}
	end := strings.Index(s[start:], "kind: Service")
	manifest := s[start : start+end]
	for _, want := range []string{
		"replicas: %[3]d",
		"maxUnavailable: 0",
		"maxSurge: 1",
		"terminationGracePeriodSeconds: 45",
		`command: ["sleep", "10"]`,
		"path: /api/health/ready",
		"path: /api/health\n",
	} {
		w := want
		if !strings.Contains(manifest, w) && !strings.Contains(manifest, strings.ReplaceAll(w, "\n", "\r\n")) {
			t.Errorf("platform-api manifest missing %q", want)
		}
	}
}
