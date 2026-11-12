package ingressha

import (
	"bytes"
	"net/netip"
	"os"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func vipConfig() *config.Config {
	return &config.Config{
		Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP,
		IngressVIP: "10.0.0.50", IngressVIPInterface: "eth0", APIVIP: "10.0.0.60",
		GitHubToken: "ghp_" + "notarealsecret", JWTSecret: "jwt-" + "notarealsecret",
	}
}

func TestJoinSettingsRoundTrip(t *testing.T) {
	want := JoinSettingsFromConfig(vipConfig())
	got, err := ParseJoinSettings([]byte(want.Render()))
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("round trip: got %+v, want %+v", got, want)
	}
	if len(Mismatches(want, got)) != 0 {
		t.Fatal("identical settings reported as mismatched")
	}
}

func TestJoinSettingsHoldNoSecret(t *testing.T) {
	body := JoinSettingsFromConfig(vipConfig()).Render()
	if strings.Contains(body, "notarealsecret") || strings.Contains(body, "K10") {
		t.Fatalf("settings carry a secret:\n%s", body)
	}
	var keys []string
	for _, line := range strings.Split(strings.TrimSpace(body), "\n") {
		if strings.HasPrefix(line, "#") {
			continue
		}
		k, _, _ := strings.Cut(line, "=")
		keys = append(keys, k)
	}
	if strings.Join(keys, ",") != "INGRESS_HA_MODE,INGRESS_VIP,INGRESS_VIP_INTERFACE,API_VIP" {
		t.Fatalf("unexpected keys %v", keys)
	}
}

func TestParseJoinSettingsRejects(t *testing.T) {
	token := "K10" + "aa" + "::server:not-a-real-secret"
	for name, in := range map[string]string{
		"token file":   token + "\n",
		"no header":    "INGRESS_HA_MODE=vip\n",
		"unknown key":  JoinSettingsHeader + "\nINGRESS_HA_MODE=vip\nK3S_TOKEN=" + token + "\n",
		"duplicate":    JoinSettingsHeader + "\nINGRESS_HA_MODE=vip\nINGRESS_HA_MODE=external\n",
		"missing mode": JoinSettingsHeader + "\nINGRESS_VIP=10.0.0.50\n",
		"too large":    JoinSettingsHeader + "\n#" + strings.Repeat("x", MaxJoinSettingsSize) + "\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseJoinSettings([]byte(in))
			if err == nil {
				t.Fatal("accepted")
			}
			if strings.Contains(err.Error(), "not-a-real-secret") {
				t.Fatal("error echoes file contents")
			}
		})
	}
}

func TestMismatches(t *testing.T) {
	cluster := JoinSettingsFromConfig(vipConfig())
	for name, mutate := range map[string]func(*JoinSettings){
		"mode":      func(s *JoinSettings) { s.Mode = config.IngressHAModeExternal },
		"vip":       func(s *JoinSettings) { s.IngressVIP = "10.0.0.51" },
		"interface": func(s *JoinSettings) { s.Interface = "" },
		"api vip":   func(s *JoinSettings) { s.APIVIP = "" },
	} {
		t.Run(name, func(t *testing.T) {
			local := cluster
			mutate(&local)
			if len(Mismatches(cluster, local)) == 0 {
				t.Fatal("mismatch not reported")
			}
		})
	}
	ext := JoinSettings{Mode: config.IngressHAModeExternal}
	if d := Mismatches(ext, JoinSettings{Mode: config.IngressHAModeExternal, IngressVIP: "10.0.0.9"}); len(d) != 0 {
		t.Fatalf("external mode compares unused VIPs: %v", d)
	}
}

func TestKubeVIPManifestAutodetectInterface(t *testing.T) {
	c := vipConfig()
	c.IngressVIPInterface = ""
	out, err := KubeVIPManifest(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "vip_interface") {
		t.Fatal("vip_interface must be omitted so kube-vip autodetects the default-route interface")
	}
}

// Every server must write the same manifest, whatever its own interfaces.
func TestPrepareJoinServerWritesIdenticalManifest(t *testing.T) {
	for _, iface := range []string{"eth0", ""} {
		t.Run("iface="+iface, func(t *testing.T) {
			c := vipConfig()
			c.IngressVIPInterface = iface
			first, _ := testHost(t, []netip.Prefix{netip.MustParsePrefix("10.0.0.10/24")})
			if _, err := first.Prepare(c); err != nil {
				t.Fatal(err)
			}
			joiner, calls := testHost(t, []netip.Prefix{netip.MustParsePrefix("10.0.0.11/24")})
			joiner.DefaultInterface = func() (string, error) { return "ens5", nil }
			if _, err := joiner.PrepareJoinServer(c); err != nil {
				t.Fatal(err)
			}
			a, err1 := os.ReadFile(first.path(ManifestPath))
			b, err2 := os.ReadFile(joiner.path(ManifestPath))
			if err1 != nil || err2 != nil || !bytes.Equal(a, b) {
				t.Fatalf("manifests differ (%v, %v)", err1, err2)
			}
			fa, _ := os.ReadFile(first.path(K3sFragmentPath))
			fb, _ := os.ReadFile(joiner.path(K3sFragmentPath))
			if !bytes.Equal(fa, fb) || len(fb) == 0 {
				t.Fatal("k3s fragments differ")
			}
			for _, call := range *calls {
				if strings.HasPrefix(call, "ping") {
					t.Fatal("joining server must not ping the VIP (kube-vip holds it)")
				}
			}
		})
	}
}

func TestPrepareJoinServerRequiresLocalInterface(t *testing.T) {
	h, _ := testHost(t, nil)
	h.InterfaceAddrs = func(name string) ([]netip.Prefix, error) {
		return nil, os.ErrNotExist
	}
	_, err := h.PrepareJoinServer(vipConfig())
	if err == nil || !strings.Contains(err.Error(), "same interface name on every server") {
		t.Fatalf("err = %v", err)
	}
	if h.exists(ManifestPath) || h.exists(K3sFragmentPath) {
		t.Fatal("files written without a usable interface")
	}
}

func TestPrepareJoinServerExternalLeavesClusterAlone(t *testing.T) {
	h, calls := testHost(t, nil)
	if _, err := h.Prepare(vipConfig()); err == nil {
		t.Fatal("expected subnet error with no interface addresses")
	}
	// Simulate a stale manifest from an earlier vip-mode join.
	_ = os.MkdirAll(strings.TrimSuffix(h.path(ManifestPath), "platform-kube-vip.yaml"), 0o755)
	_ = os.WriteFile(h.path(ManifestPath), []byte("old"), 0o600)
	_ = os.MkdirAll(strings.TrimSuffix(h.path(k3sBinary), "k3s"), 0o755)
	_ = os.WriteFile(h.path(k3sBinary), []byte("x"), 0o755)
	*calls = (*calls)[:0]
	if _, err := h.PrepareJoinServer(&config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeExternal}); err != nil {
		t.Fatal(err)
	}
	if h.exists(ManifestPath) {
		t.Fatal("manifest kept in external mode")
	}
	if len(*calls) != 0 {
		t.Fatalf("joining server ran cluster commands: %v", *calls)
	}
}
