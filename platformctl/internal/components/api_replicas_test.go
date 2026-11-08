package components

import (
	"encoding/json"
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

// The update path converges to the provision manifest: same #18 settings.
func TestAPIRolloutPatchMatchesProvisionManifest(t *testing.T) {
	var patch struct {
		Spec struct {
			Replicas int `json:"replicas"`
			Strategy struct {
				RollingUpdate struct {
					MaxUnavailable int `json:"maxUnavailable"`
					MaxSurge       int `json:"maxSurge"`
				} `json:"rollingUpdate"`
			} `json:"strategy"`
			Template struct {
				Spec struct {
					Grace      int `json:"terminationGracePeriodSeconds"`
					Containers []struct {
						Name      string `json:"name"`
						Lifecycle struct {
							PreStop struct {
								Exec struct {
									Command []string `json:"command"`
								} `json:"exec"`
							} `json:"preStop"`
						} `json:"lifecycle"`
						Readiness struct {
							HTTPGet struct {
								Path string `json:"path"`
							} `json:"httpGet"`
						} `json:"readinessProbe"`
						Liveness struct {
							HTTPGet struct {
								Path string `json:"path"`
							} `json:"httpGet"`
						} `json:"livenessProbe"`
					} `json:"containers"`
				} `json:"spec"`
			} `json:"template"`
		} `json:"spec"`
	}
	if err := json.Unmarshal([]byte(apiRolloutPatch(2)), &patch); err != nil {
		t.Fatal(err)
	}
	s := patch.Spec
	c := s.Template.Spec.Containers
	if s.Replicas != 2 || s.Strategy.RollingUpdate.MaxUnavailable != 0 || s.Strategy.RollingUpdate.MaxSurge != 1 ||
		s.Template.Spec.Grace != 45 || len(c) != 1 || c[0].Name != "api" ||
		strings.Join(c[0].Lifecycle.PreStop.Exec.Command, " ") != "sleep 10" ||
		c[0].Readiness.HTTPGet.Path != "/api/health/ready" || c[0].Liveness.HTTPGet.Path != "/api/health" {
		t.Fatalf("unexpected rollout patch: %+v", s)
	}
}

// update: backup + migrate Job before the new image, rollout settings after it.
func TestUpdateImagesMigratesThenRollsThenReconcilesRollout(t *testing.T) {
	calls := fakeTools(t)
	cfg := &config.Config{ImageRegistry: "ghcr.io/test", ImageTag: "v1", PostgresPassword: "pg", APIReplicas: 2}
	if err := UpdateImages(cfg); err != nil {
		t.Fatal(err)
	}
	dump, roll, rollout := -1, -1, -1
	for i, c := range calls() {
		joined := strings.Join(c.Args, " ")
		switch {
		case c.Tool == "bash" && strings.Contains(joined, "pg_dump"):
			dump = i
		case c.Tool == "bash" && strings.Contains(joined, "run_api_migrations \"$API\"") && strings.Contains(joined, "set image"):
			if strings.Index(joined, "run_api_migrations \"$API\"") > strings.Index(joined, "kubectl set image") {
				t.Fatal("images set before migrations")
			}
			roll = i
		case c.Tool == "bash" && strings.Contains(joined, "/api/health/ready") && strings.Contains(joined, "PodDisruptionBudget"):
			rollout = i
		}
	}
	if dump < 0 || roll < 0 || rollout < 0 || !(dump < roll && roll < rollout) {
		t.Fatalf("wrong update order: dump=%d roll=%d rollout=%d", dump, roll, rollout)
	}
}
