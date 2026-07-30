package helm

import (
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func IsInstalled() bool {
	return shell.Exists("helm")
}

func Install() error {
	color.Cyan("\n  ■ Installing Helm...")

	if state.IsDone("helm") && IsInstalled() {
		color.Green("  ✓ Helm already installed")
		return addRepos()
	}

	if !IsInstalled() {
		if err := shell.RunBash("curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash"); err != nil {
			return fmt.Errorf("helm install failed: %w", err)
		}
	} else {
		color.Green("  ✓ Helm already installed")
	}

	if err := addRepos(); err != nil {
		return err
	}
	return state.MarkDone("helm")
}

func addRepos() error {
	color.Cyan("  ■ Adding Helm repositories...")

	repos := map[string]string{
		"bitnami":              "https://charts.bitnami.com/bitnami",
		"ingress-nginx":        "https://kubernetes.github.io/ingress-nginx",
		"jetstack":             "https://charts.jetstack.io",
		"grafana":              "https://grafana.github.io/helm-charts",
		"prometheus-community": "https://prometheus-community.github.io/helm-charts",
		"argo":                 "https://argoproj.github.io/argo-helm",
		"portainer":            "https://portainer.github.io/k8s/",
		"oauth2-proxy":         "https://oauth2-proxy.github.io/manifests",
	}

	for name, url := range repos {
		_ = shell.RunBash(fmt.Sprintf("helm repo add %s %s 2>/dev/null || true", name, url))
	}

	_ = shell.RunBash("helm repo update 2>/dev/null || true")
	color.Green("  ✓ Helm repositories configured")
	return nil
}
