// Package harden manages the single-node Ubuntu host baseline. All host access
// is injected; config generation is pure and tests never need root.
package harden

import (
	"fmt"
	"net/netip"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"
)

const SSHPath = "/etc/ssh/sshd_config.d/60-platform.conf"

func HasKey(data []byte) bool {
	for _, line := range strings.Split(string(data), "\n") {
		_, _, options, rest, err := ssh.ParseAuthorizedKey([]byte(line))
		// Restricted keys (forced commands, source restrictions, etc.) are not
		// evidence that the operator can open an unrestricted login session.
		if err == nil && len(options) == 0 && len(strings.TrimSpace(string(rest))) == 0 {
			return true
		}
	}
	return false
}

func SSHConfig(key bool) string {
	if !key {
		return "# No unrestricted authorized key: password authentication left unchanged.\n"
	}
	return "# Managed by platformctl harden\nPermitRootLogin prohibit-password\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\n"
}

const UpdatesConfig = `// Managed by platformctl harden (Ubuntu/Debian security only).
#clear Unattended-Upgrade::Allowed-Origins;
#clear Unattended-Upgrade::Origins-Pattern;
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
  "${distro_id}ESMApps:${distro_codename}-apps-security";
  "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
`

const PeriodicConfig = `APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
`

func Fail2banConfig() string {
	return "# Managed by platformctl\n[sshd]\nenabled = true\nbackend = systemd\nport = ssh\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\nbanaction = nftables-multiport\n"
}

// NginxAuthJail is opt-in: the operator exports the controller's nginx error
// stream to this host file (CRI stdout access logs are not auth error logs).
const NginxAuthJail = `[nginx-http-auth]
enabled = true
backend = auto
port = http,https
logpath = /var/log/platform/ingress-error.log
maxretry = 5
findtime = 10m
bantime = 1h
banaction = nftables-multiport
`

// CIDRs accepts the scalar/list forms k3s supports, including dual-stack. A
// malformed or unknown YAML shape fails closed rather than guessing networks.
func CIDRs(data []byte) ([]netip.Prefix, error) {
	values := map[string]string{"cluster-cidr": "10.42.0.0/16", "service-cidr": "10.43.0.0/16"}
	var listKey string
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "- ") && listKey != "" {
			values[listKey] += "," + strings.TrimSpace(line[2:])
			continue
		}
		listKey = ""
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		if _, wanted := values[k]; !wanted {
			continue
		}
		v = strings.TrimSpace(v)
		values[k] = strings.Trim(v, "[]")
		if v == "" {
			listKey = k
		}
	}
	var result []netip.Prefix
	for _, k := range []string{"cluster-cidr", "service-cidr"} {
		for _, v := range strings.Split(values[k], ",") {
			v = strings.Trim(strings.TrimSpace(v), "\"'")
			if v == "" {
				continue
			}
			p, err := netip.ParsePrefix(v)
			if err != nil {
				return nil, fmt.Errorf("invalid k3s %s: %w", k, err)
			}
			result = append(result, p.Masked())
		}
	}
	if len(result) < 2 {
		return nil, fmt.Errorf("empty k3s CIDR configuration")
	}
	return result, nil
}

// FirewallOptions adds optional ha-profile rules (control-plane VIP).
type FirewallOptions struct {
	APIVIP     netip.Addr
	NodeSubnet netip.Prefix
	// Peers are the PLATFORM_CLUSTER_NODES prefixes (#53): the inter-node
	// ports (etcd, API, kubelet, flannel) are accepted only from them.
	Peers []netip.Prefix
}

// Firewall returns the single-node baseline ruleset (no API VIP extras).
func Firewall(cidrs []netip.Prefix) string {
	return FirewallWith(cidrs, FirewallOptions{})
}

// ClusterFirewall renders the policy plus the inter-node ports for the ha
// profile, accepted only from the given peers.
func ClusterFirewall(cidrs, peers []netip.Prefix) string {
	return FirewallWith(cidrs, FirewallOptions{Peers: peers})
}

// FirewallWith is Firewall plus an optional rule allowing the node subnet to
// reach the floating Kubernetes API VIP on 6443 (ha profile with API_VIP).
func FirewallWith(cidrs []netip.Prefix, opt FirewallOptions) string {
	var trusted strings.Builder
	// Trust interfaces, not externally spoofable source addresses. CIDRs are
	// constrained to internal-facing traffic (interfaces above are sufficient
	// for normal flannel; this also documents the configured network ranges).
	for _, p := range cidrs {
		family := "ip"
		if p.Addr().Is6() {
			family = "ip6"
		}
		fmt.Fprintf(&trusted, "    iifname { \"cni0\", \"flannel.*\" } %s saddr %s accept\n", family, p)
	}
	var apiVIPRule string
	if opt.APIVIP.IsValid() && opt.APIVIP.Is4() && opt.NodeSubnet.IsValid() && opt.NodeSubnet.Addr().Is4() {
		apiVIPRule = fmt.Sprintf("    ip saddr %s ip daddr %s tcp dport 6443 accept\n", opt.NodeSubnet.Masked(), opt.APIVIP)
	}
	return `table inet platform_guard {
  chain input {
    type filter hook input priority 10; policy drop;
    iifname "lo" accept
    ct state established,related accept
    ct state invalid drop
    iifname { "cni0", "flannel.*" } accept
` + trusted.String() + apiVIPRule + `    meta l4proto { icmp, ipv6-icmp } accept
    udp sport 67 udp dport 68 accept
    udp sport 547 udp dport 546 accept
    tcp dport { 22, 80, 443 } accept
` + clusterRules(opt.Peers) + `  }
  chain forward {
    type filter hook forward priority 10; policy drop;
    ct state established,related accept
    ct state invalid drop
    iifname { "cni0", "flannel.*" } accept
    meta l4proto tcp ct original proto-dst { 80, 443 } accept
  }
}
`
}

// Quote is used only for fixed executable paths, including injected test roots.
func Quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// Ports are shared with callers documenting inter-node firewall requirements.
// 9100: node-exporter runs on the host network; Prometheus scrapes every node
// from wherever it is scheduled (without it 2 of 3 nodes had no host metrics).
var ClusterTCPPorts = []int{2379, 2380, 6443, 9100, 10250}
var ClusterUDPPorts = []int{8472}

func clusterRules(peers []netip.Prefix) string {
	var b strings.Builder
	for _, family := range []string{"ip", "ip6"} {
		var addresses []string
		for _, p := range peers {
			if p.Addr().Is6() == (family == "ip6") {
				addresses = append(addresses, p.String())
			}
		}
		if len(addresses) == 0 {
			continue
		}
		for _, protocol := range []struct {
			name  string
			ports []int
		}{{"tcp", ClusterTCPPorts}, {"udp", ClusterUDPPorts}} {
			if len(protocol.ports) == 0 {
				continue
			}
			var ports []string
			for _, port := range protocol.ports {
				ports = append(ports, strconv.Itoa(port))
			}
			portSet := strings.Join(ports, ", ")
			if len(ports) > 1 {
				portSet = "{ " + portSet + " }"
			}
			fmt.Fprintf(&b, "    %s saddr { %s } %s dport %s accept\n", family, strings.Join(addresses, ", "), protocol.name, portSet)
		}
	}
	return b.String()
}

// ParsePeers parses PLATFORM_CLUSTER_NODES (IPs or CIDRs), refusing overly broad ranges.
func ParsePeers(values []string) ([]netip.Prefix, error) {
	seen := map[netip.Prefix]bool{}
	var out []netip.Prefix
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		p, err := netip.ParsePrefix(value)
		if err != nil {
			addr, addrErr := netip.ParseAddr(value)
			if addrErr != nil || addr.Zone() != "" {
				return nil, fmt.Errorf("invalid cluster peer %q", value)
			}
			p = netip.PrefixFrom(addr, addr.BitLen())
		}
		if p.Addr().Is4() && p.Bits() < 8 || p.Addr().Is6() && p.Bits() < 32 {
			return nil, fmt.Errorf("cluster peer %q is too broad", value)
		}
		p = p.Masked()
		if !seen[p] {
			out = append(out, p)
			seen[p] = true
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if c := out[i].Addr().Compare(out[j].Addr()); c != 0 {
			return c < 0
		}
		return out[i].Bits() < out[j].Bits()
	})
	return out, nil
}
