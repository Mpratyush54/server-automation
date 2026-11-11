package components

import (
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"

	"github.com/fatih/color"

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

// SyntheticsRunnerAPIURL is where browser runners fetch definitions and report
// results: the platform-api-synthetics Service, which exposes only the runner
// endpoints (the API's SYNTHETICS_RUNNER_PORT).
const SyntheticsRunnerAPIURL = "http://platform-api-synthetics.platform.svc:3001"

// SyntheticsRunnerImage is the browser runner image for this release.
func SyntheticsRunnerImage(c *config.Config) string {
	return fmt.Sprintf("%s/platform-synthetics-runner:%s", c.ImageRegistry, c.ImageTag)
}

// syntheticsRunnerConfigMap is the API-facing switch for browser checks.
func syntheticsRunnerConfigMap(c *config.Config) map[string]any {
	data := map[string]string{
		"browser": "disabled",
		// Dedicated runner port of the API (runner endpoints only; see synthetics.yaml).
		"apiUrl": SyntheticsRunnerAPIURL,
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

// SyntheticsCAConfigMap is the synthetics-namespace copy of the platform CA
// certificate (public part only), mounted by browser runners so they trust the
// project's environment hosts when those are served by the internal CA.
const SyntheticsCAConfigMap = "platform-ca"

// caCertificatePEM returns only the CERTIFICATE blocks of pemData (never a key),
// or "" when there are none.
func caCertificatePEM(pemData string) string {
	var out strings.Builder
	rest := []byte(pemData)
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type == "CERTIFICATE" && len(block.Headers) == 0 {
			_ = pem.Encode(&out, block)
		}
	}
	return out.String()
}

// syntheticsCAConfigMap renders the CA copy, or nil when there is no certificate.
func syntheticsCAConfigMap(caPEM string) map[string]any {
	cert := caCertificatePEM(caPEM)
	if cert == "" {
		return nil
	}
	return map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name":      SyntheticsCAConfigMap,
			"namespace": "synthetics",
			"labels":    map[string]string{"app.kubernetes.io/managed-by": "platformctl"},
		},
		"data": map[string]string{"ca.crt": cert},
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
	// Best effort: without the copy, env hosts served by the internal CA fail TLS
	// in browser checks (Let's Encrypt certificates are trusted anyway).
	if cm := syntheticsCAConfigMap(kubeSecretValue("cert-manager", "platform-ca", "ca.crt")); cm != nil {
		if b, err := json.Marshal(cm); err == nil {
			if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, string(b)); err != nil {
				color.Yellow("  ⚠ synthetics: publishing the platform CA for browser checks failed: %v", err)
			}
		}
	} else {
		color.Yellow("  ⚠ synthetics: could not read ca.crt from secret cert-manager/platform-ca; browser checks against internal-CA hosts will fail TLS until `platformctl` is re-run")
	}
	return state.MarkDone("synthetics")
}
