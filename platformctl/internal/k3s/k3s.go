package k3s

import (
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

func IsInstalled() bool {
	return shell.Exists("k3s")
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// RegistriesPath is read by k3s' containerd at start-up. Credentials here are
// what `k3s crictl pull` and kubelet use — `docker login` never applied to k3s.
const RegistriesPath = "/etc/rancher/k3s/registries.yaml"

// RegistriesYAML renders registries.yaml for an authenticated GHCR pull.
// Returns "" when no token is configured.
func RegistriesYAML(githubToken string) string {
	if githubToken == "" {
		return ""
	}
	return fmt.Sprintf("configs:\n  \"ghcr.io\":\n    auth:\n      username: oauth2\n      password: %q\n", githubToken)
}

// WriteRegistries writes registries.yaml before k3s starts. It reports whether
// the file changed; a running k3s must be restarted to pick up a change.
func WriteRegistries(githubToken string) (bool, error) {
	content := RegistriesYAML(githubToken)
	if content == "" {
		return false, nil
	}
	if cur, err := os.ReadFile(RegistriesPath); err == nil && string(cur) == content {
		return false, nil
	}
	if err := os.MkdirAll("/etc/rancher/k3s", 0755); err != nil {
		return false, err
	}
	if err := os.WriteFile(RegistriesPath, []byte(content), 0600); err != nil {
		return false, err
	}
	return true, nil
}

func Install(domain, githubToken string) error {
	color.Cyan("\n  ■ Installing K3s %s...", versions.K3sVersion)

	changed, err := WriteRegistries(githubToken)
	if err != nil {
		color.Yellow("  ⚠ could not write %s: %v", RegistriesPath, err)
	}
	if changed && IsInstalled() {
		color.Cyan("  ■ Registry credentials changed — restarting k3s...")
		_ = shell.RunBash("systemctl restart k3s")
	}

	// k3s reads /etc/rancher/k3s/config.yaml on every start, so these settings
	// apply to fresh installs and are reconciled on existing ones.
	cfgChanged, err := WriteServerConfig(upstreamDNS())
	if err != nil {
		return fmt.Errorf("write k3s config: %w", err)
	}
	if cfgChanged && IsInstalled() {
		color.Cyan("  ■ k3s configuration changed — restarting k3s...")
		if err := shell.RunBash("systemctl restart k3s"); err != nil {
			return fmt.Errorf("restart k3s: %w", err)
		}
		if err := WaitReady(); err != nil {
			return err
		}
	}

	if state.IsDone("k3s") && IsInstalled() {
		color.Green("  ✓ K3s already installed")
		return PatchCoreDNS(domain)
	}

	if !IsInstalled() {
		// Traefik is disabled and DNS configured via config.yaml (see WriteServerConfig).
		if err := shell.RunBash(fmt.Sprintf(
			`curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=%s sh -`,
			shellQuote(versions.K3sVersion))); err != nil {
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

const (
	// ServerConfigPath is k3s' own config file, read on every start.
	ServerConfigPath = "/etc/rancher/k3s/config.yaml"
	// ResolvConfPath is the upstream resolver file handed to kubelet; CoreDNS
	// (dnsPolicy: Default) forwards external names to these servers.
	ResolvConfPath = "/etc/rancher/k3s/resolv.conf"
)

// upstreamDNS returns the resolvers for external names: PLATFORM_UPSTREAM_DNS
// (comma separated) or public resolvers. The host's systemd-resolved stub
// (127.0.0.53) is unusable from pods and slow IPv6 paths caused timeouts.
func upstreamDNS() []string {
	if v := strings.TrimSpace(os.Getenv("PLATFORM_UPSTREAM_DNS")); v != "" {
		var out []string
		for _, s := range strings.Split(v, ",") {
			if s = strings.TrimSpace(s); s != "" {
				out = append(out, s)
			}
		}
		if len(out) > 0 {
			return out
		}
	}
	return []string{"1.1.1.1", "8.8.8.8"}
}

// ServerConfigYAML renders /etc/rancher/k3s/config.yaml.
//
// secrets-encryption encrypts Secrets at rest in the datastore: the API's
// configuration, credentials and OIDC signing key live in Secrets (#20).
// On an existing cluster k3s creates the key on the next restart; Secrets
// are encrypted as they are next written (platformctl rewrites its own on
// every provision/update; `k3s secrets-encrypt reencrypt` covers the rest).
func ServerConfigYAML() string {
	return "# Managed by platformctl\ndisable:\n  - traefik\nresolv-conf: " + ResolvConfPath + "\nsecrets-encryption: true\n"
}

// ResolvConf renders the upstream resolver file.
func ResolvConf(servers []string) string {
	var b strings.Builder
	b.WriteString("# Managed by platformctl (PLATFORM_UPSTREAM_DNS)\n")
	for _, s := range servers {
		b.WriteString("nameserver " + s + "\n")
	}
	return b.String()
}

// WriteServerConfig writes the k3s config and resolver files. It reports
// whether anything changed (a running k3s must then be restarted).
func WriteServerConfig(servers []string) (bool, error) {
	if err := os.MkdirAll("/etc/rancher/k3s", 0755); err != nil {
		return false, err
	}
	changed := false
	for path, content := range map[string]string{
		ServerConfigPath: ServerConfigYAML(),
		ResolvConfPath:   ResolvConf(servers),
	} {
		if cur, err := os.ReadFile(path); err == nil && string(cur) == content {
			continue
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			return false, err
		}
		changed = true
	}
	return changed, nil
}

// CoreDNSOverride renders the rewrite rules that send the platform domain and
// its subdomains to the ingress controller, so in-cluster clients reach
// https://DOMAIN without hairpinning through the public IP.
func CoreDNSOverride(domain string) string {
	escaped := strings.ReplaceAll(domain, ".", `\.`)
	return fmt.Sprintf("rewrite name regex (.*)\\.%s ingress-nginx-controller.ingress-nginx.svc.cluster.local\n"+
		"rewrite name %s ingress-nginx-controller.ingress-nginx.svc.cluster.local\n", escaped, domain)
}

// PatchCoreDNS installs the domain rewrite through k3s' supported extension
// point, the kube-system/coredns-custom ConfigMap (imported via
// "import /etc/coredns/custom/*.override"). The k3s-managed coredns ConfigMap
// is never edited: k3s reverts manual edits, and editing it raced the addon
// controller on fresh installs ("the object has been modified").
func PatchCoreDNS(domain string) error {
	if domain == "" {
		domain = "platform.local"
	}
	color.Cyan("  ■ Configuring CoreDNS domain rewrite (coredns-custom)...")
	override := CoreDNSOverride(domain)
	bash := fmt.Sprintf(`
		set -euo pipefail
		export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
		for i in $(seq 1 60); do
		  kubectl -n kube-system get deploy coredns >/dev/null 2>&1 && break
		  sleep 2
		done
		cur="$(kubectl -n kube-system get configmap coredns-custom -o jsonpath='{.data.platform\.override}' 2>/dev/null || true)"
		want=%s
		if [[ "$cur" == "${want%%$'\n'}" || "$cur" == "$want" ]]; then
		  echo "CoreDNS rewrite already configured"
		  exit 0
		fi
		for i in 1 2 3 4 5; do
		  kubectl -n kube-system create configmap coredns-custom \
		    --from-literal=platform.override="$want" \
		    --dry-run=client -o yaml | kubectl apply -f - && break
		  [[ $i == 5 ]] && exit 1
		  sleep 3
		done
		kubectl -n kube-system rollout restart deploy/coredns
		kubectl -n kube-system rollout status deploy/coredns --timeout=120s
	`, shellQuote(override))

	if err := shell.RunBash(bash); err != nil {
		return fmt.Errorf("coredns rewrite failed: %w", err)
	}
	color.Green("  ✓ CoreDNS configured")
	return nil
}

func GetKubeConfig() string {
	return "/etc/rancher/k3s/k3s.yaml"
}
