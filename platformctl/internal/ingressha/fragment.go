package ingressha

import (
	"fmt"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// K3sFragmentPath is merged by k3s from config.yaml.d (keys ending in + append).
const K3sFragmentPath = "/etc/rancher/k3s/config.yaml.d/60-platform-ingress-ha.yaml"

// ManifestPath is auto-applied by k3s from server/manifests at start and on change.
const ManifestPath = "/var/lib/rancher/k3s/server/manifests/platform-kube-vip.yaml"

// K3sConfigFragment returns the config.yaml.d snippet that disables ServiceLB
// (so kube-vip owns the LoadBalancer IP) and optionally adds API_VIP to tls-san.
// Empty when ingress HA does not use vip mode.
func K3sConfigFragment(c *config.Config) string {
	if c == nil || !c.IsHA() || strings.ToLower(strings.TrimSpace(c.IngressHAMode)) != config.IngressHAModeVIP {
		return ""
	}
	var b strings.Builder
	b.WriteString("# Managed by platformctl (ingress HA, #54)\n")
	b.WriteString("disable+:\n")
	b.WriteString("  - servicelb\n")
	if api := strings.TrimSpace(c.APIVIP); api != "" {
		b.WriteString("tls-san+:\n")
		fmt.Fprintf(&b, "  - %s\n", api)
	}
	return b.String()
}

// WriteK3sFragment writes (vip mode) or removes (external mode) only the k3s
// config fragment, without the kube-vip manifest or the VIP subnet checks that
// Prepare runs on the first server. `platformctl join --role server` calls it
// before k3s starts so every server agrees on the ServiceLB setting (a critical
// k3s setting: a mismatch makes k3s refuse the joining server) and serves the
// API VIP in its certificate. The kube-vip manifest stays on the first server:
// its DaemonSet already runs on every control-plane node.
func (h Host) WriteK3sFragment(c *config.Config) (changed bool, err error) {
	if c == nil || !c.IsHA() {
		return false, nil
	}
	if err := c.ValidateIngressHA(); err != nil {
		return false, err
	}
	return h.writeOrRemove(K3sFragmentPath, K3sConfigFragment(c))
}
