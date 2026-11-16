package ingressha

import (
	"encoding/binary"
	"fmt"
	"net/netip"
)

// ValidateVIP checks that vip is a usable floating IPv4 on the same L2 subnet
// as one of ifaceAddrs, and is not already assigned to this host or another
// listed node IP. Network and broadcast addresses are rejected for IPv4
// prefixes longer than point-to-point (/31+/32).
func ValidateVIP(vip netip.Addr, ifaceAddrs []netip.Prefix, nodeIPs []netip.Addr) error {
	if !vip.IsValid() || !vip.Is4() {
		return fmt.Errorf("VIP must be a valid IPv4 address")
	}
	if vip.IsLoopback() || vip.IsMulticast() || vip.IsUnspecified() {
		return fmt.Errorf("VIP %s is not a usable host address", vip)
	}
	for _, n := range nodeIPs {
		if n.IsValid() && n == vip {
			return fmt.Errorf("VIP %s equals a node IP", vip)
		}
	}
	for _, p := range ifaceAddrs {
		if p.Addr().IsValid() && p.Addr() == vip {
			return fmt.Errorf("VIP %s equals an interface address", vip)
		}
	}
	var matched netip.Prefix
	found := false
	for _, p := range ifaceAddrs {
		if !p.IsValid() || !p.Addr().Is4() {
			continue
		}
		if p.Contains(vip) {
			matched = p
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("VIP %s is outside every interface subnet", vip)
	}
	if matched.Bits() <= 30 {
		network, broadcast := ipv4NetworkBroadcast(matched)
		if vip == network {
			return fmt.Errorf("VIP %s is the network address of %s", vip, matched.Masked())
		}
		if vip == broadcast {
			return fmt.Errorf("VIP %s is the broadcast address of %s", vip, matched.Masked())
		}
	}
	return nil
}

func ipv4NetworkBroadcast(p netip.Prefix) (network, broadcast netip.Addr) {
	a := p.Masked().Addr().As4()
	ip := binary.BigEndian.Uint32(a[:])
	var mask uint32
	if bits := p.Bits(); bits > 0 {
		mask = ^uint32(0) << (32 - bits)
	}
	netu := ip & mask
	bcast := netu | ^mask
	var n4, b4 [4]byte
	binary.BigEndian.PutUint32(n4[:], netu)
	binary.BigEndian.PutUint32(b4[:], bcast)
	return netip.AddrFrom4(n4), netip.AddrFrom4(b4)
}
