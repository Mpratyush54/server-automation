package k3s

import (
	"fmt"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

func IsInstalled() bool {
	return shell.Exists("k3s")
}

func Install() error {
	color.Cyan("\n  ■ Installing K3s Kubernetes...")

	if IsInstalled() {
		color.Green("  ✓ K3s already installed")
		return nil
	}

	if err := shell.RunBash("curl -sfL https://get.k3s.io | sh -"); err != nil {
		return fmt.Errorf("k3s install failed: %w", err)
	}

	if err := WaitReady(); err != nil {
		return err
	}

	return setupKubeconfig()
}

func WaitReady() error {
	color.Cyan("  ■ Waiting for K3s to be ready...")
	return shell.RunBash(`while ! k3s kubectl get node >/dev/null 2>&1; do sleep 5; done`)
}

func setupKubeconfig() error {
	color.Cyan("  ■ Setting up kubeconfig...")

	kubeDir := "/root/.kube"
	shell.MkdirAll(kubeDir)

	content := `export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"`
	shell.AppendFile("/root/.bashrc", "\n"+content+"\n")

	if !shell.FileExists("/root/.kube/config") {
		shell.RunBash("cp /etc/rancher/k3s/k3s.yaml /root/.kube/config && chmod 600 /root/.kube/config")
	}

	color.Green("  ✓ K3s ready")
	return nil
}

func GetKubeConfig() string {
	return "/etc/rancher/k3s/k3s.yaml"
}
