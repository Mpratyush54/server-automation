package helm

import (
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

func IsInstalled() bool {
	return shell.Exists("helm")
}

func Install() error {
	color.Cyan("\n  ■ Installing Helm...")

	if IsInstalled() {
		color.Green("  ✓ Helm already installed")
		return nil
	}

	cmds := []string{
		"curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash",
	}

	for _, c := range cmds {
		if err := shell.RunBash(c); err != nil {
			return fmt.Errorf("helm install failed: %w", err)
		}
	}

	return addRepos()
}

func addRepos() error {
	color.Cyan("  ■ Adding Helm repositories...")

	repos := map[string]string{
		"bitnami":    "https://charts.bitnami.com/bitnami",
		"ingress-nginx": "https://kubernetes.github.io/ingress-nginx",
		"jetstack":   "https://charts.jetstack.io",
		"grafana":    "https://grafana.github.io/helm-charts",
		"prometheus-community": "https://prometheus-community.github.io/helm-charts",
		"argo":       "https://argoproj.github.io/argo-helm",
		"minio":      "https://operator.min.io",
		"portainer":  "https://portainer.github.io/k8s",
		"infisical":  "https://dl.cloudsmith.io/public/infisical/helm/helm/charts",
	}

	for name, url := range repos {
		if err := shell.RunBash(fmt.Sprintf("helm repo add %s %s 2>/dev/null || true", name, url)); err != nil {
			return fmt.Errorf("failed to add repo %s: %w", name, err)
		}
	}

	shell.RunBash("helm repo update 2>/dev/null || true")
	color.Green("  ✓ Helm repositories configured")
	return nil
}
