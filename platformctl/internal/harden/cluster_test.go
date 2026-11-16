package harden

import (
	"net/netip"
	"strings"
	"testing"
)

func TestParsePeers(t *testing.T) {
	peers, err := ParsePeers([]string{" 10.0.0.11 ", "10.0.0.3/24", "10.0.0.11/32", "2001:db8::2", "2001:db8::3/32", ""})
	if err != nil {
		t.Fatal(err)
	}
	var values []string
	for _, p := range peers {
		values = append(values, p.String())
	}
	if strings.Join(values, ",") != "10.0.0.0/24,10.0.0.11/32,2001:db8::/32,2001:db8::2/128" {
		t.Fatal(values)
	}
	for _, value := range []string{"bad", "0.0.0.0/0", "10.0.0.0/7", "::/0", "2001:db8::/31", "fe80::1%eth0"} {
		if _, err := ParsePeers([]string{value}); err == nil {
			t.Fatal(value)
		}
	}
	for _, value := range []string{"10.0.0.0/8", "2001:db8::/32"} {
		if _, err := ParsePeers([]string{value}); err != nil {
			t.Fatal(value, err)
		}
	}
}

func TestClusterFirewall(t *testing.T) {
	cidrs, _ := CIDRs(nil)
	base := Firewall(cidrs)
	if base != ClusterFirewall(cidrs, nil) {
		t.Fatal("single node changed")
	}
	peers := []netip.Prefix{netip.MustParsePrefix("10.0.0.11/32"), netip.MustParsePrefix("10.0.0.0/24"), netip.MustParsePrefix("2001:db8::1/128")}
	rules := "    ip saddr { 10.0.0.11/32, 10.0.0.0/24 } tcp dport { 2379, 2380, 6443, 9100, 10250 } accept\n    ip saddr { 10.0.0.11/32, 10.0.0.0/24 } udp dport 8472 accept\n    ip6 saddr { 2001:db8::1/128 } tcp dport { 2379, 2380, 6443, 9100, 10250 } accept\n    ip6 saddr { 2001:db8::1/128 } udp dport 8472 accept\n"
	anchor := "    tcp dport { 22, 80, 443 } accept\n"
	if got := ClusterFirewall(cidrs, peers); got != strings.Replace(base, anchor, anchor+rules, 1) {
		t.Fatal(got)
	}
	if got := ClusterFirewall(cidrs, peers[:2]); strings.Contains(got, "ip6 saddr") {
		t.Fatal(got)
	}
	a, b := ClusterTCPPorts, ClusterUDPPorts
	t.Cleanup(func() { ClusterTCPPorts, ClusterUDPPorts = a, b })
	ClusterTCPPorts = []int{1234}
	ClusterUDPPorts = []int{4321, 4322}
	got := ClusterFirewall(cidrs, peers[:1])
	if !strings.Contains(got, "tcp dport 1234") || !strings.Contains(got, "udp dport { 4321, 4322 }") {
		t.Fatal(got)
	}
}

func TestApplyClusterFirewall(t *testing.T) {
	h, _ := testHost(t)
	h.ClusterPeers = []netip.Prefix{netip.MustParsePrefix("10.0.0.11/32")}
	if err := h.ApplyFirewall(func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	cidrs, _ := CIDRs(nil)
	want := ClusterFirewall(cidrs, h.ClusterPeers)
	for _, path := range []string{runtimeDir + "/apply.nft", "/etc/platform/firewall.nft"} {
		data, err := h.read(path)
		if err != nil {
			t.Fatal(err)
		}
		expected := want
		if strings.HasSuffix(path, "apply.nft") {
			expected = "delete table inet platform_guard\n" + want
		}
		if string(data) != expected {
			t.Fatal(path, string(data))
		}
	}
}
