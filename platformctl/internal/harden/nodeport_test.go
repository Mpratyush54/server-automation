package harden

import (
	"net/netip"
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
