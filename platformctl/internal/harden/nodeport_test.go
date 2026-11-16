package harden

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ingress-nginx runs with externalTrafficPolicy=Local, which needs node ports
// for k3s ServiceLB. Those ports must stay unreachable from outside: the
// forward chain may only admit connections originally addressed to 80/443.
func TestFirewallDoesNotForwardNodePorts(t *testing.T) {
	fw := Firewall([]netip.Prefix{netip.MustParsePrefix("10.42.0.0/16"), netip.MustParsePrefix("10.43.0.0/16")})
	fwd := fw[strings.Index(fw, "chain forward"):]
	if !strings.Contains(fwd, "policy drop;") || !strings.Contains(fwd, "ct original proto-dst { 80, 443 } accept") {
		t.Fatalf("forward chain admits more than 80/443:\n%s", fwd)
	}
	if strings.Contains(fw, "30000") || strings.Contains(fw, "32767") {
		t.Fatal("node port range opened")
	}
}

// tcp 80/443 on input (and original proto-dst 80/443 on forward) already cover
// traffic to a floating ingress VIP: kube-proxy DNATs the LB IP to the local
// controller pod. No extra VIP-specific allow is required for ingress.
func TestFirewallAllowsIngressVIPPorts(t *testing.T) {
	fw := Firewall([]netip.Prefix{netip.MustParsePrefix("10.42.0.0/16"), netip.MustParsePrefix("10.43.0.0/16")})
	if !strings.Contains(fw, "tcp dport { 22, 80, 443 } accept") {
		t.Fatal("input missing 80/443")
	}
	if !strings.Contains(fw, "ct original proto-dst { 80, 443 } accept") {
		t.Fatal("forward missing 80/443 DNAT cover")
	}
}

func TestFirewallWithAPIVIP(t *testing.T) {
	cidrs := []netip.Prefix{netip.MustParsePrefix("10.42.0.0/16"), netip.MustParsePrefix("10.43.0.0/16")}
	base := Firewall(cidrs)
	with := FirewallWith(cidrs, FirewallOptions{
		APIVIP:     netip.MustParseAddr("10.0.0.60"),
		NodeSubnet: netip.MustParsePrefix("10.0.0.0/24"),
	})
	want := "ip saddr 10.0.0.0/24 ip daddr 10.0.0.60 tcp dport 6443 accept"
	if !strings.Contains(with, want) {
		t.Fatalf("missing API VIP rule:\n%s", with)
	}
	if strings.Contains(base, "6443") {
		t.Fatal("Firewall() must stay unchanged without options")
	}
	if FirewallWith(cidrs, FirewallOptions{}) != base {
		t.Fatal("empty options must match Firewall()")
	}
}

func TestRefuseCIDRFragmentsAllowsIngressHA(t *testing.T) {
	h, _ := testHost(t)
	dir := h.Path("/etc/rancher/k3s/config.yaml.d")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	ok := filepath.Join(dir, "60-platform-ingress-ha.yaml")
	if err := os.WriteFile(ok, []byte("# Managed\ndisable+:\n  - servicelb\ntls-san+:\n  - 10.0.0.60\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := h.refuseCIDRFragments(); err != nil {
		t.Fatal(err)
	}
	bad := filepath.Join(dir, "99-cidrs.yaml")
	if err := os.WriteFile(bad, []byte("cluster-cidr+: 10.44.0.0/16\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := h.refuseCIDRFragments(); err == nil {
		t.Fatal("expected refusal for cluster-cidr+")
	}
}
