package components

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// InstallKyverno installs Kyverno (full profile + INSTALL_KYVERNO only) with
// explicit resource requests/limits, then applies the platform image-signature
// ClusterPolicy (Audit by default; Enforce via KYVERNO_POLICY_MODE).
func InstallKyverno(cfg *config.Config) error {
	if !cfg.InstallKyverno {
		color.Yellow("  ○ kyverno skipped (set INSTALL_KYVERNO=true with PLATFORM_PROFILE=full)")
		return nil
	}
	if doneOrSkip("kyverno", "kyverno") {
		// Still reconcile the policy mode on re-runs.
		return applyKyvernoPolicies(cfg)
	}
	color.Cyan("\n  ■ Installing Kyverno (admission image verification)...")

	// Pin resources so a single-server box is not starved. Chart 3.3.7 /
	// Kyverno v1.13.x images come from reg.kyverno.io (see images.txt).
	err := shell.RunBash(`
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
` + helmLockHelper + `
clear_helm_lock kyverno kyverno
helm upgrade --install kyverno ` + chart("kyverno") + ` \
  --namespace kyverno --create-namespace \
  --set admissionController.replicas=1 \
  --set webhooksCleanup.image.repository=bitnamilegacy/kubectl \
  --set policyReportsCleanup.image.repository=bitnamilegacy/kubectl \
  --set backgroundController.enabled=true \
  --set cleanupController.enabled=true \
  --set reportsController.enabled=true \
  --set admissionController.container.resources.requests.cpu=100m \
  --set admissionController.container.resources.requests.memory=256Mi \
  --set admissionController.container.resources.limits.cpu=500m \
  --set admissionController.container.resources.limits.memory=512Mi \
  --set backgroundController.resources.requests.cpu=50m \
  --set backgroundController.resources.requests.memory=128Mi \
  --set backgroundController.resources.limits.cpu=200m \
  --set backgroundController.resources.limits.memory=256Mi \
  --set cleanupController.resources.requests.cpu=50m \
  --set cleanupController.resources.requests.memory=64Mi \
  --set cleanupController.resources.limits.cpu=100m \
  --set cleanupController.resources.limits.memory=128Mi \
  --set reportsController.resources.requests.cpu=50m \
  --set reportsController.resources.requests.memory=128Mi \
  --set reportsController.resources.limits.cpu=200m \
  --set reportsController.resources.limits.memory=256Mi \
  --wait --timeout 10m
`)
	if err != nil {
		return fmt.Errorf("install kyverno: %w", err)
	}
	if err := applyKyvernoPolicies(cfg); err != nil {
		return err
	}
	color.Green("  ✓ Kyverno installed (policy mode %s)", kyvernoPolicyMode(cfg))
	return state.MarkDone("kyverno")
}

func kyvernoPolicyMode(cfg *config.Config) string {
	mode := strings.TrimSpace(cfg.KyvernoPolicyMode)
	if mode == "" {
		mode = strings.TrimSpace(os.Getenv("KYVERNO_POLICY_MODE"))
	}
	switch strings.ToLower(mode) {
	case "enforce":
		return "Enforce"
	default:
		return "Audit"
	}
}

// renderVerifyImagesPolicy fills the policy mode. Kyverno rejects
// mutateDigest=true unless the failure action is Enforce, so digest pinning
// is only enabled together with enforcement.
func renderVerifyImagesPolicy(manifest, mode string) string {
	manifest = strings.ReplaceAll(manifest, "{{VALIDATION_FAILURE_ACTION}}", mode)
	return strings.ReplaceAll(manifest, "{{MUTATE_DIGEST}}", strconv.FormatBool(mode == "Enforce"))
}

func applyKyvernoPolicies(cfg *config.Config) error {
	manifest := readManifest("kyverno-verify-images.yaml")
	if manifest == "" {
		return fmt.Errorf("kyverno-verify-images.yaml manifest missing")
	}
	mode := kyvernoPolicyMode(cfg)
	manifest = renderVerifyImagesPolicy(manifest, mode)
	if out, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, manifest); err != nil {
		return fmt.Errorf("apply kyverno verifyImages policy: %w: %s", err, strings.TrimSpace(out))
	}
	// Optional CVE policy: only when explicitly requested. Trivy Operator is
	// NOT installed here; see docs/operations/image-signing.md.
	if cfg.InstallKyvernoCVEPolicy || os.Getenv("INSTALL_KYVERNO_CVE_POLICY") == "true" {
		cve := readManifest("kyverno-cve-policy.yaml")
		if cve == "" {
			return fmt.Errorf("kyverno-cve-policy.yaml manifest missing")
		}
		cve = strings.ReplaceAll(cve, "{{VALIDATION_FAILURE_ACTION}}", mode)
		if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, cve); err != nil {
			return fmt.Errorf("apply kyverno CVE policy: %w", err)
		}
		color.Cyan("    · CVE ClusterPolicy applied (requires Trivy Operator reports)")
	}
	return nil
}
