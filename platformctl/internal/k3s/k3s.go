package k3s

import (
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func IsInstalled() bool {
	return shell.Exists("k3s")
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func Install(domain string) error {
	color.Cyan("\n  ■ Installing K3s Kubernetes...")

	if state.IsDone("k3s") && IsInstalled() {
		color.Green("  ✓ K3s already installed")
		return PatchCoreDNS(domain)
	}

	if !IsInstalled() {
		// Disable Traefik — Platform uses ingress-nginx.
		if err := shell.RunBash(`curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -`); err != nil {
			return fmt.Errorf("k3s install failed: %w", err)
		}
	} else {
		color.Green("  ✓ K3s already installed")
	}

	if err := WaitReady(); err != nil {
		return err
	}

	if err := setupKubeconfig(); err != nil {
		return err
	}

	if err := PatchCoreDNS(domain); err != nil {
		return err
	}

	return state.MarkDone("k3s")
}

func WaitReady() error {
	color.Cyan("  ■ Waiting for K3s to be ready...")
	return shell.RunBash(`
		for i in $(seq 1 60); do
		  k3s kubectl get node >/dev/null 2>&1 && exit 0
		  sleep 2
		done
		echo "k3s did not become ready in time" >&2
		exit 1
	`)
}

func setupKubeconfig() error {
	color.Cyan("  ■ Setting up kubeconfig...")

	_ = shell.MkdirAll("/root/.kube")
	_ = shell.RunBash("cp /etc/rancher/k3s/k3s.yaml /root/.kube/config && chmod 600 /root/.kube/config")
	_ = shell.AppendFile("/root/.bashrc", "\nexport KUBECONFIG=\"${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}\"\n")
	_ = shell.RunBash(`
		if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
		  mkdir -p "/home/${SUDO_USER}/.kube"
		  cp /etc/rancher/k3s/k3s.yaml "/home/${SUDO_USER}/.kube/config"
		  chown "${SUDO_USER}:${SUDO_USER}" "/home/${SUDO_USER}/.kube/config"
		  chmod 600 "/home/${SUDO_USER}/.kube/config"
		fi
	`)

	color.Green("  ✓ K3s ready")
	return nil
}

func PatchCoreDNS(domain string) error {
	if domain == "" {
		domain = "platform.local"
	}
	color.Cyan("  ■ Patching CoreDNS (upstream DNS + domain rewrite)...")

	script := `import json, os, sys
domain = os.environ["PLATFORM_DOMAIN"]
escaped = domain.replace(".", r"\.")
data = json.load(sys.stdin)
corefile = data["data"]["Corefile"]
rules = f"""
        rewrite name regex (.*)\\.{escaped} ingress-nginx-controller.ingress-nginx.svc.cluster.local
        rewrite name {domain} ingress-nginx-controller.ingress-nginx.svc.cluster.local
"""
lines = [l for l in corefile.split("\n") if "rewrite name" not in l]
corefile = "\n".join(lines)
if "ready" in corefile:
    corefile = corefile.replace("ready", "ready" + rules, 1)
corefile = corefile.replace("/etc/resolv.conf", "8.8.8.8 8.8.4.4")
data["data"]["Corefile"] = corefile
print(json.dumps(data))
`
	tmp := "/tmp/platformctl-coredns-patch.py"
	if err := shell.WriteFile(tmp, script); err != nil {
		return err
	}
	defer os.Remove(tmp)

	bash := fmt.Sprintf(`
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		export PLATFORM_DOMAIN=%s
		for i in $(seq 1 30); do
		  kubectl get configmap -n kube-system coredns >/dev/null 2>&1 && break
		  sleep 2
		done
		kubectl get configmap -n kube-system coredns -o json | python3 %s | kubectl apply -f -
		kubectl rollout restart -n kube-system deploy/coredns
		kubectl wait --for=condition=Available deploy/coredns -n kube-system --timeout=60s || true
	`, shellQuote(domain), tmp)

	if err := shell.RunBash(bash); err != nil {
		return fmt.Errorf("coredns patch failed: %w", err)
	}
	color.Green("  ✓ CoreDNS patched")
	return nil
}

func GetKubeConfig() string {
	return "/etc/rancher/k3s/k3s.yaml"
}
