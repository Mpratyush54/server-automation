package ingressha

import (
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

func TestValidateVIP(t *testing.T) {
	subnet := netip.MustParsePrefix("10.0.0.10/24")
	ifaceAddrs := []netip.Prefix{subnet}
	nodeIPs := []netip.Addr{netip.MustParseAddr("10.0.0.10")}

	tests := []struct {
		name    string
		vip     string
		wantErr string
	}{
		{"ok", "10.0.0.50", ""},
		{"outside subnet", "10.0.1.50", "outside"},
		{"equals node IP", "10.0.0.10", "node IP"},
		{"network addr", "10.0.0.0", "network"},
		{"broadcast addr", "10.0.0.255", "broadcast"},
		{"loopback", "127.0.0.1", "usable"},
		{"unspecified", "0.0.0.0", "usable"},
		{"multicast", "224.0.0.1", "usable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vip := netip.MustParseAddr(tt.vip)
			err := ValidateVIP(vip, ifaceAddrs, nodeIPs)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want substring %q", err, tt.wantErr)
			}
		})
	}
}

func TestKubeVIPManifest(t *testing.T) {
	for _, withAPI := range []bool{false, true} {
		name := "without-api-vip"
		c := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50"}
		if withAPI {
			name = "with-api-vip"
			c.APIVIP = "10.0.0.60"
		}
		t.Run(name, func(t *testing.T) {
			out, err := KubeVIPManifest(c, "eth0")
			if err != nil {
				t.Fatal(err)
			}
			docs := splitYAMLDocs(out)
			if len(docs) != 4 {
				t.Fatalf("got %d YAML documents, want 4", len(docs))
			}
			if !strings.Contains(out, "image: \""+versions.KubeVIPImage+"\"") {
				t.Fatal("missing pinned image")
			}
			if !strings.Contains(out, "value: \"eth0\"") || !strings.Contains(out, "name: vip_interface") {
				t.Fatal("missing vip_interface")
			}
			for _, env := range []string{"vip_arp", "svc_enable", "svc_election", "vip_leaseduration", "vip_renewdeadline", "vip_retryperiod"} {
				if !strings.Contains(out, "name: "+env) {
					t.Fatal("missing env", env)
				}
			}
			if !strings.Contains(out, "NET_ADMIN") || !strings.Contains(out, "NET_RAW") || !strings.Contains(out, `drop: ["ALL"]`) {
				t.Fatal("capabilities")
			}
			if !strings.Contains(out, "node-role.kubernetes.io/control-plane") || !strings.Contains(out, "operator: Exists") {
				t.Fatal("nodeAffinity")
			}
			if withAPI {
				if !strings.Contains(out, `name: cp_enable`) || !strings.Contains(out, `value: "true"`) {
					t.Fatal("cp_enable true")
				}
				if !strings.Contains(out, `value: "10.0.0.60"`) || !strings.Contains(out, "plndr-cp-lock") {
					t.Fatal("API VIP env")
				}
			} else {
				if !strings.Contains(out, "name: cp_enable") || !strings.Contains(out, `value: "false"`) {
					t.Fatal("cp_enable false")
				}
				if strings.Contains(out, "plndr-cp-lock") {
					t.Fatal("unexpected cp lease")
				}
			}
		})
	}
	if _, err := KubeVIPManifest(&config.Config{}, "bad iface!"); err == nil {
		t.Fatal("accepted invalid interface")
	}
}

func splitYAMLDocs(s string) []string {
	var docs []string
	var cur strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if line == "---" {
			docs = append(docs, cur.String())
			cur.Reset()
			continue
		}
		if cur.Len() > 0 {
			cur.WriteByte('\n')
		}
		cur.WriteString(line)
	}
	if strings.TrimSpace(cur.String()) != "" {
		docs = append(docs, cur.String())
	}
	return docs
}

func TestK3sConfigFragment(t *testing.T) {
	vip := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50"}
	got := K3sConfigFragment(vip)
	if !strings.Contains(got, "disable+:") || !strings.Contains(got, "- servicelb") {
		t.Fatalf("vip fragment: %q", got)
	}
	if strings.Contains(got, "tls-san") {
		t.Fatal("unexpected tls-san without API_VIP")
	}
	vip.APIVIP = "10.0.0.60"
	got = K3sConfigFragment(vip)
	if !strings.Contains(got, "tls-san+:") || !strings.Contains(got, "- 10.0.0.60") {
		t.Fatalf("api vip fragment: %q", got)
	}
	ext := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeExternal}
	if K3sConfigFragment(ext) != "" {
		t.Fatal("external should be empty")
	}
	std := &config.Config{Profile: config.ProfileStandard, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50"}
	if K3sConfigFragment(std) != "" {
		t.Fatal("non-ha should be empty")
	}
}

func TestPrepare(t *testing.T) {
	prefixes := []netip.Prefix{netip.MustParsePrefix("10.0.0.10/24")}

	t.Run("non-ha", func(t *testing.T) {
		h, calls := testHost(t, prefixes)
		restart, err := h.Prepare(&config.Config{Profile: config.ProfileStandard})
		if err != nil || restart {
			t.Fatalf("restart=%v err=%v", restart, err)
		}
		if len(*calls) != 0 {
			t.Fatalf("commands: %v", *calls)
		}
		if entries, _ := os.ReadDir(h.Root); len(entries) != 0 {
			t.Fatal("wrote files on non-ha")
		}
	})

	t.Run("vip fresh", func(t *testing.T) {
		h, calls := testHost(t, prefixes)
		// No k3s binary → no restart.
		c := &config.Config{
			Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP,
			IngressVIP: "10.0.0.50", IngressVIPInterface: "eth0",
		}
		restart, err := h.Prepare(c)
		if err != nil {
			t.Fatal(err)
		}
		if restart {
			t.Fatal("fresh install should not restart")
		}
		frag, err := os.ReadFile(h.path(K3sFragmentPath))
		if err != nil || !strings.Contains(string(frag), "servicelb") {
			t.Fatalf("fragment: %s %v", frag, err)
		}
		man, err := os.ReadFile(h.path(ManifestPath))
		if err != nil || !strings.Contains(string(man), versions.KubeVIPImage) {
			t.Fatalf("manifest: %v", err)
		}
		joined := strings.Join(*calls, "\n")
		if !strings.Contains(joined, "ping -c 1 -W 1 10.0.0.50") {
			t.Fatalf("expected ping preflight, got %v", *calls)
		}
	})

	t.Run("vip unchanged", func(t *testing.T) {
		h, calls := testHost(t, prefixes)
		_ = os.MkdirAll(filepath.Dir(h.path("/usr/local/bin/k3s")), 0755)
		_ = os.WriteFile(h.path("/usr/local/bin/k3s"), []byte("x"), 0755)
		c := &config.Config{
			Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP,
			IngressVIP: "10.0.0.50", IngressVIPInterface: "eth0",
		}
		if _, err := h.Prepare(c); err != nil {
			t.Fatal(err)
		}
		*calls = (*calls)[:0]
		restart, err := h.Prepare(c)
		if err != nil {
			t.Fatal(err)
		}
		if restart {
			t.Fatal("unchanged fragment must not restart")
		}
		for _, c := range *calls {
			if strings.Contains(c, "delete daemonset") {
				t.Fatalf("unexpected cleanup on unchanged: %v", *calls)
			}
		}
	})

	t.Run("external after vip", func(t *testing.T) {
		h, calls := testHost(t, prefixes)
		_ = os.MkdirAll(filepath.Dir(h.path("/usr/local/bin/k3s")), 0755)
		_ = os.WriteFile(h.path("/usr/local/bin/k3s"), []byte("x"), 0755)
		vip := &config.Config{
			Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP,
			IngressVIP: "10.0.0.50", IngressVIPInterface: "eth0",
		}
		if _, err := h.Prepare(vip); err != nil {
			t.Fatal(err)
		}
		*calls = (*calls)[:0]
		ext := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeExternal}
		restart, err := h.Prepare(ext)
		if err != nil {
			t.Fatal(err)
		}
		if !restart {
			t.Fatal("removing fragment with k3s installed should restart")
		}
		if _, err := os.Stat(h.path(K3sFragmentPath)); !os.IsNotExist(err) {
			t.Fatal("fragment not removed")
		}
		if _, err := os.Stat(h.path(ManifestPath)); !os.IsNotExist(err) {
			t.Fatal("manifest not removed")
		}
		joined := strings.Join(*calls, "\n")
		if !strings.Contains(joined, "delete daemonset kube-vip-ds") {
			t.Fatalf("expected kube-vip cleanup, got %v", *calls)
		}
	})
}

func testHost(t *testing.T, prefixes []netip.Prefix) (Host, *[]string) {
	t.Helper()
	calls := []string{}
	h := Host{
		Root: t.TempDir(),
		Run: func(name string, args ...string) (string, error) {
			calls = append(calls, name+" "+strings.Join(args, " "))
			if name == "ping" {
				return "", errors.New("1 packets transmitted, 0 received")
			}
			return "", nil
		},
		InterfaceAddrs:   func(string) ([]netip.Prefix, error) { return prefixes, nil },
		DefaultInterface: func() (string, error) { return "eth0", nil },
	}
	return h, &calls
}

func TestPrepareOnVIPHolder(t *testing.T) {
	// kube-vip binds held VIPs as /32 host addresses; a re-run on the holder
	// must not mistake them for node IPs.
	prefixes := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.10/24"),
		netip.MustParsePrefix("10.0.0.50/32"),
		netip.MustParsePrefix("10.0.0.60/32"),
	}
	h, calls := testHost(t, prefixes)
	c := &config.Config{
		Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP,
		IngressVIP: "10.0.0.50", APIVIP: "10.0.0.60",
	}
	if err := os.MkdirAll(filepath.Dir(h.path(ManifestPath)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(h.path(ManifestPath), []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Prepare(c); err != nil {
		t.Fatal(err)
	}
	for _, call := range *calls {
		if strings.HasPrefix(call, "ping") {
			t.Fatalf("ping must be skipped once kube-vip is deployed: %v", *calls)
		}
	}
	man, _ := os.ReadFile(h.path(ManifestPath))
	if !strings.Contains(string(man), `value: "10.0.0.60"`) {
		t.Fatal("manifest not refreshed")
	}
	frag, _ := os.ReadFile(h.path(K3sFragmentPath))
	if !strings.Contains(string(frag), "tls-san+:\n  - 10.0.0.60\n") {
		t.Fatalf("fragment: %q", frag)
	}
}

func TestPrepareRejects(t *testing.T) {
	prefixes := []netip.Prefix{netip.MustParsePrefix("10.0.0.10/24")}
	for name, c := range map[string]*config.Config{
		"vip is node ip":     {Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.10"},
		"vip outside subnet": {Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "192.168.1.5"},
		"api vip outside":    {Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50", APIVIP: "192.168.1.5"},
		"vip without ip":     {Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP},
	} {
		t.Run(name, func(t *testing.T) {
			h, _ := testHost(t, prefixes)
			if _, err := h.Prepare(c); err == nil {
				t.Fatal("expected error")
			}
			if h.exists(K3sFragmentPath) || h.exists(ManifestPath) {
				t.Fatal("files written despite invalid config")
			}
		})
	}

	t.Run("vip answers ping", func(t *testing.T) {
		h, _ := testHost(t, prefixes)
		h.Run = func(name string, args ...string) (string, error) { return "1 received", nil }
		c := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50"}
		if _, err := h.Prepare(c); err == nil || !strings.Contains(err.Error(), "another host") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestCleanupServiceLB(t *testing.T) {
	h, calls := testHost(t, nil)
	h.CleanupServiceLB(&config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeExternal})
	h.CleanupServiceLB(&config.Config{Profile: config.ProfileFull, IngressHAMode: config.IngressHAModeVIP})
	if len(*calls) != 0 {
		t.Fatalf("cleanup outside ha vip mode: %v", *calls)
	}
	h.CleanupServiceLB(&config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50"})
	if len(*calls) != 1 || !strings.Contains((*calls)[0], "-l svccontroller.k3s.cattle.io/svcname") {
		t.Fatalf("calls = %v", *calls)
	}
}
