package components

import (
	"encoding/json"
	"fmt"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// Synthetic monitoring (#42). Full profile only: the "synthetics" provision step
// runs after "telemetry" (blackbox-exporter + prometheus-operator CRDs) and applies
// the synthetics namespace, quotas, egress policies and the platform API's scoped
// RBAC, then publishes the synthetics-runner ConfigMap the API reads to decide
// whether browser checks are available.
//
// Browser checks (headless Chromium, ~1 GiB image, up to 1 CPU / 1 GiB per run,
// at most 2 at once) are an explicit opt-in on top of the full profile:
// SYNTHETICS_BROWSER=true. HTTP, multi-step and SSL checks need no extra
// workload: they run inside the API (every profile) and, on the full profile,
// are mirrored as blackbox-exporter Probes.

// SyntheticsRunnerImage is the browser runner image for this release.
func SyntheticsRunnerImage(c *config.Config) string {
	return fmt.Sprintf("%s/platform-synthetics-runner:%s", c.ImageRegistry, c.ImageTag)
}

// syntheticsRunnerConfigMap is the API-facing switch for browser checks.
func syntheticsRunnerConfigMap(c *config.Config) map[string]any {
	data := map[string]string{
		"browser": "disabled",
		"apiUrl":  "http://platform-api.platform.svc:3000",
	}
	if c.SyntheticsBrowser {
		data["browser"] = "enabled"
		data["image"] = SyntheticsRunnerImage(c)
	}
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name":      "synthetics-runner",
			"namespace": "synthetics",
			"labels":    map[string]string{"app.kubernetes.io/managed-by": "platformctl"},
		},
		"data": data,
	}
}

// InstallSynthetics applies the synthetics namespace and policies (full profile).
func InstallSynthetics(c *config.Config) error {
	if !FullTelemetry(c) {
		return nil
	}
	manifest := readManifest("synthetics.yaml")
	if manifest == "" {
		return fmt.Errorf("synthetics manifest missing")
	}
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, manifest); err != nil {
		return fmt.Errorf("synthetics: %w", err)
	}
	b, err := json.Marshal(syntheticsRunnerConfigMap(c))
	if err != nil {
		return err
	}
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, string(b)); err != nil {
		return fmt.Errorf("synthetics runner config: %w", err)
	}
	return state.MarkDone("synthetics")
}
