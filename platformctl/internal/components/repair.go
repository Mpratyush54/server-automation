package components

import (
	"fmt"
	"os"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// RepairSSO re-applies every piece of SSO wiring from the current config. It
// is idempotent and is what `platformctl repair` runs, so an install made by an
// older platformctl (placeholder client secrets, public-URL server calls, no
// client registry) converges to the current, self-contained setup.
func RepairSSO(cfg *config.Config) error {
	color.Cyan("\n  ■ Repairing SSO wiring (OIDC client registry, Grafana, ArgoCD, oauth2-proxy, Portainer)...")
	var failed []string
	step := func(name string, fn func() error) {
		if err := fn(); err != nil {
			color.Yellow("  ⚠ %s: %v", name, err)
			failed = append(failed, name)
			return
		}
		color.Green("  ✓ %s", name)
	}

	step("API OIDC issuer + client registry", func() error {
		return shell.RunBash(fmt.Sprintf(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n platform get secret platform-env >/dev/null
kubectl -n platform patch secret platform-env --type merge -p "$(python3 -c '
import base64, json, sys
print(json.dumps({"data": {k: base64.b64encode(v.encode()).decode() for k, v in
    {"OIDC_ISSUER": sys.argv[1], "OIDC_CLIENTS": sys.argv[2]}.items()}}))
' %s %s)" >/dev/null
kubectl -n platform rollout restart deploy/platform-api >/dev/null
kubectl -n platform rollout status deploy/platform-api --timeout=180s >/dev/null`,
			shellQuote(cfg.OIDCIssuer()), shellQuote(cfg.OIDCClientsJSON())))
	})

	if cfg.InstallMonitoring {
		step("Grafana SSO", func() error { return helmReapplyValues(cfg, "kube-prometheus", "monitoring", "kube-prometheus-stack", "grafana-values.yaml") })
	}
	if cfg.InstallArgoCD {
		step("ArgoCD SSO", func() error {
			if err := helmReapplyValues(cfg, "argocd", "argocd", "argo-cd", "argocd-values.yaml"); err != nil {
				return err
			}
			return patchArgoCDSubpath(cfg)
		})
	}
	step("oauth2-proxy", func() error {
		_ = state.Clear("oauth2-proxy")
		return InstallOAuthProxy(cfg)
	})
	if cfg.InstallPortainer {
		step("Portainer SSO", func() error {
			pass := cfg.PortainerPassword
			if pass == "" {
				pass = cfg.AdminPassword
			}
			if err := ensurePortainerAdminAndSSO(cfg, pass); err != nil {
				return err
			}
			return state.MarkDone("portainer-sso")
		})
	}
	if len(failed) > 0 {
		return fmt.Errorf("SSO repair incomplete: %v", failed)
	}
	return nil
}

// helmReapplyValues upgrades a release with the current templated values file
// on top of its existing values (keeps generated passwords, updates SSO keys).
func helmReapplyValues(cfg *config.Config, release, ns, chartName, valuesFile string) error {
	tmp, err := os.CreateTemp("", "platformctl-values-*.yaml")
	if err != nil {
		return err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	if err := writeTemplatedManifest(valuesFile, cfg, tmp.Name()); err != nil {
		return err
	}
	extra := ""
	if release == "argocd" {
		extra = "--set applicationSet.replicas=0"
	}
	return shell.RunBash(fmt.Sprintf(`set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
helm status %[1]s -n %[2]s >/dev/null 2>&1 || { echo "%[1]s not installed — skipping"; exit 0; }
helm upgrade %[1]s %[3]s -n %[2]s --reuse-values -f %[4]s %[5]s --wait --timeout 5m >/dev/null`,
		release, ns, chart(chartName), tmp.Name(), extra))
}
