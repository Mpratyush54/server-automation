package ingressha

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// k3sBinary marks an existing k3s install (a changed fragment then needs a restart).
const k3sBinary = "/usr/local/bin/k3s"

// Host isolates filesystem and command access so Prepare is testable without
// root: files live under Root (empty = /), commands and interface lookups are
// injected.
type Host struct {
	Root string

	Run              func(name string, args ...string) (string, error)
	InterfaceAddrs   func(name string) ([]netip.Prefix, error)
	DefaultInterface func() (string, error)
}

// Default returns a Host wired to the real OS.
func Default() Host {
	return Host{Run: runCommand, InterfaceAddrs: realInterfaceAddrs, DefaultInterface: realDefaultInterface}
}

func (h Host) path(p string) string {
	if h.Root == "" {
		return p
	}
	return filepath.Join(h.Root, filepath.FromSlash(strings.TrimPrefix(p, "/")))
}

func (h Host) exists(p string) bool {
	_, err := os.Stat(h.path(p))
	return err == nil
}

// Prepare writes or removes the k3s ingress-HA config fragment and the kube-vip
// manifest. It must run before k3s starts on the first server. restartK3s is
// true when the fragment changed on an installed k3s; the caller restarts k3s,
// waits for it and then calls CleanupServiceLB.
func (h Host) Prepare(c *config.Config) (restartK3s bool, err error) {
	return h.prepare(c, false)
}

// PrepareJoinServer is Prepare for a server added with `platformctl join
// --role server`, run before k3s starts there. It writes the same k3s
// fragment (every server must agree on `disable: servicelb`, which k3s treats
// as critical config, and serve API_VIP in its certificate) and the same
// kube-vip manifest as the first server, so the auto-deploy source survives
// the loss of any one server's disk. Unlike Prepare it skips the "VIP answers
// ping" check (kube-vip already holds the VIPs in a running cluster) and, in
// external mode, only removes local files: the cluster-wide kube-vip
// DaemonSet is the first server's business.
func (h Host) PrepareJoinServer(c *config.Config) (restartK3s bool, err error) {
	return h.prepare(c, true)
}

func (h Host) prepare(c *config.Config, joining bool) (restartK3s bool, err error) {
	if c == nil || !c.IsHA() {
		return false, nil
	}
	if err := c.ValidateIngressHA(); err != nil {
		return false, err
	}
	k3sInstalled := h.exists(k3sBinary)

	if c.IngressHAMode == config.IngressHAModeExternal {
		fragChanged, err := h.writeOrRemove(K3sFragmentPath, "")
		if err != nil {
			return false, err
		}
		manifestRemoved, err := h.writeOrRemove(ManifestPath, "")
		if err != nil {
			return false, err
		}
		// k3s never deletes resources whose auto-deploy manifest was removed.
		if manifestRemoved && k3sInstalled && !joining {
			_, _ = h.Run("k3s", "kubectl", "-n", "kube-system", "delete", "daemonset", "kube-vip-ds", "--ignore-not-found")
		}
		return fragChanged && k3sInstalled, nil
	}

	iface, err := h.Interface(c)
	if err != nil {
		return false, err
	}
	if err := h.validateVIPs(c, iface); err != nil {
		return false, err
	}
	// Best effort "already in use" check, only before kube-vip is deployed:
	// afterwards the VIP answers because kube-vip holds it. ICMP may be
	// filtered, so silence does not prove the address is free.
	vip := strings.TrimSpace(c.IngressVIP)
	if !joining && !h.exists(ManifestPath) {
		if out, err := h.Run("ping", "-c", "1", "-W", "1", vip); err == nil {
			return false, fmt.Errorf("INGRESS_VIP %s answers ping, so another host uses it; choose an unused address (%s)", vip, strings.TrimSpace(out))
		}
	}

	manifest, err := KubeVIPManifest(c)
	if err != nil {
		return false, err
	}
	fragChanged, err := h.writeOrRemove(K3sFragmentPath, K3sConfigFragment(c))
	if err != nil {
		return false, err
	}
	if _, err := h.writeOrRemove(ManifestPath, manifest); err != nil {
		return false, err
	}
	return fragChanged && k3sInstalled, nil
}

// CleanupServiceLB deletes the svclb DaemonSets that k3s ServiceLB created
// before it was disabled (switching an existing install to vip mode): with
// ServiceLB off nothing removes them and they keep binding 80/443 on every
// node. Best effort; call after k3s restarted with the new fragment.
func (h Host) CleanupServiceLB(c *config.Config) {
	if c == nil || !c.IsHA() || c.IngressHAMode != config.IngressHAModeVIP {
		return
	}
	_, _ = h.Run("k3s", "kubectl", "-n", "kube-system", "delete", "daemonset", "-l", "svccontroller.k3s.cattle.io/svcname", "--ignore-not-found")
}

// Interface returns INGRESS_VIP_INTERFACE or the IPv4 default-route interface
// (the one kube-vip autodetects when vip_interface is unset). The VIP subnet
// checks run against it. A set INGRESS_VIP_INTERFACE must exist on this node:
// the manifest is shared by every server, so the name must be the same on all
// of them.
func (h Host) Interface(c *config.Config) (string, error) {
	if iface := strings.TrimSpace(c.IngressVIPInterface); iface != "" {
		if !ifaceNameRE.MatchString(iface) {
			return "", fmt.Errorf("invalid INGRESS_VIP_INTERFACE %q", iface)
		}
		if _, err := h.InterfaceAddrs(iface); err != nil {
			return "", fmt.Errorf("INGRESS_VIP_INTERFACE %s is not usable on this node (%v); kube-vip uses the same interface name on every server, so give the interface that name on all servers, or leave INGRESS_VIP_INTERFACE unset on the whole cluster so kube-vip uses each node's default-route interface", iface, err)
		}
		return iface, nil
	}
	iface, err := h.DefaultInterface()
	if err != nil {
		return "", fmt.Errorf("detect VIP interface (set INGRESS_VIP_INTERFACE): %w", err)
	}
	return iface, nil
}

// NodePrefixes returns the interface's own addresses, without the VIPs that
// kube-vip has already bound to it (it adds them as /32 host addresses), so
// re-running provision on the VIP holder still validates.
func (h Host) NodePrefixes(iface string, vips ...string) ([]netip.Prefix, error) {
	all, err := h.InterfaceAddrs(iface)
	if err != nil {
		return nil, fmt.Errorf("interface %s addresses: %w", iface, err)
	}
	held := map[netip.Addr]bool{}
	for _, v := range vips {
		if a, err := netip.ParseAddr(strings.TrimSpace(v)); err == nil {
			held[a] = true
		}
	}
	var out []netip.Prefix
	for _, p := range all {
		if p.IsSingleIP() && held[p.Addr()] {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

func (h Host) validateVIPs(c *config.Config, iface string) error {
	prefixes, err := h.NodePrefixes(iface, c.IngressVIP, c.APIVIP)
	if err != nil {
		return err
	}
	nodeIPs := make([]netip.Addr, 0, len(prefixes))
	for _, p := range prefixes {
		nodeIPs = append(nodeIPs, p.Addr())
	}
	for _, v := range []struct{ name, value string }{{"INGRESS_VIP", c.IngressVIP}, {"API_VIP", c.APIVIP}} {
		if strings.TrimSpace(v.value) == "" {
			continue
		}
		addr, err := netip.ParseAddr(strings.TrimSpace(v.value))
		if err != nil {
			return fmt.Errorf("%s: %w", v.name, err)
		}
		if err := ValidateVIP(addr, prefixes, nodeIPs); err != nil {
			return fmt.Errorf("%s on %s: %w", v.name, iface, err)
		}
	}
	return nil
}

// writeOrRemove writes content when non-empty (only if different) or removes
// the file when content is empty. It reports whether the file changed.
func (h Host) writeOrRemove(path, content string) (bool, error) {
	p := h.path(path)
	old, readErr := os.ReadFile(p)
	if content == "" {
		if readErr != nil {
			return false, nil
		}
		return true, os.Remove(p)
	}
	if readErr == nil && string(old) == content {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		return false, err
	}
	return true, nil
}

func realInterfaceAddrs(name string) ([]netip.Prefix, error) {
	iface, err := net.InterfaceByName(name)
	if err != nil {
		return nil, err
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return nil, err
	}
	var out []netip.Prefix
	for _, a := range addrs {
		v, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(v.IP)
		if !ok {
			continue
		}
		ones, bits := v.Mask.Size()
		if bits == 0 {
			continue
		}
		if ip.Is4In6() && bits == 128 {
			ones -= 96
		}
		// PrefixFrom keeps the host address; Addr.Prefix would mask it to the
		// network address and lose the node IP.
		out = append(out, netip.PrefixFrom(ip.Unmap(), ones))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no addresses on %s", name)
	}
	return out, nil
}

// realDefaultInterface returns the interface of the IPv4 default route
// (Destination 00000000 in /proc/net/route).
func realDefaultInterface() (string, error) {
	data, err := os.ReadFile("/proc/net/route")
	if err != nil {
		return "", err
	}
	for i, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if i == 0 || len(fields) < 2 || fields[1] != "00000000" {
			continue
		}
		if !ifaceNameRE.MatchString(fields[0]) {
			return "", fmt.Errorf("default route interface %q looks invalid", fields[0])
		}
		return fields[0], nil
	}
	return "", fmt.Errorf("no IPv4 default route in /proc/net/route")
}
