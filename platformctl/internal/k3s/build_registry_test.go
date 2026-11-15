package k3s

import (
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildRegistryMirrorRoutesToClusterServiceAndPreservesGHCR(t *testing.T) {
	settings := BuildRegistrySettings{Host: "registry.example.com", Endpoint: "http://10.43.12.34:5000"}
	got := BuildRegistriesYAML("existing-token", settings)
	for _, want := range []string{"ghcr.io", "existing-token", "mirrors:", `"registry.example.com"`, `"http://10.43.12.34:5000"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s", want)
		}
	}
	// Credentials live in per-project pull Secrets, never in node configuration.
	if strings.Count(got, "auth:") != 1 || strings.Contains(got, "insecure_skip_verify") || strings.Contains(got, "ca_file") {
		t.Fatalf("unexpected registry configuration:\n%s", got)
	}
	if BuildRegistriesYAML("token", BuildRegistrySettings{}) != RegistriesYAML("token") {
		t.Fatal("changed existing install")
	}
	if BuildRegistriesYAML("token", BuildRegistrySettings{Host: "registry.example.com"}) != RegistriesYAML("token") {
		t.Fatal("legacy settings without an endpoint must not render a mirror")
	}
	if !strings.HasPrefix(BuildRegistriesYAML("", settings), "mirrors:\n") {
		t.Fatal("missing mirror without GHCR")
	}
}

func TestBuildRegistryEndpointIsAClusterIPOnly(t *testing.T) {
	for endpoint, ok := range map[string]bool{
		"http://10.43.12.34:5000":          true,
		"http://[fd00::10]:5000":           true,
		"https://10.43.12.34:5000":         false,
		"http://registry.example.com:5000": false,
		"http://10.43.12.34:443":           false,
		"http://user:pw@10.43.12.34:5000":  false,
		"http://10.43.12.34:5000/v2":       false,
		"http://10.43.12.34:5000?x=1":      false,
	} {
		if ValidBuildRegistryEndpoint(endpoint) != ok {
			t.Errorf("%s: want %v", endpoint, ok)
		}
	}
}

func TestHostsWithEntryMapsTheRegistryTokenHostOnce(t *testing.T) {
	ip := netip.MustParseAddr("10.43.0.20")
	in := "127.0.0.1 localhost\n10.43.9.9 registry-token.cairn.internal\n# comment registry-token.cairn.internal\n::1 ip6-localhost\n"
	got := HostsWithEntry(in, "registry-token.cairn.internal", ip)
	want := "127.0.0.1 localhost\n# comment registry-token.cairn.internal\n::1 ip6-localhost\n10.43.0.20 registry-token.cairn.internal\n"
	if got != want {
		t.Fatalf("got:\n%s", got)
	}
	if HostsWithEntry(got, "registry-token.cairn.internal", ip) != got {
		t.Fatal("not idempotent")
	}
	if HostsWithEntry("", "h.internal", ip) != "10.43.0.20 h.internal\n" {
		t.Fatal("empty hosts file")
	}
}

func TestWriteHostsEntryKeepsOtherEntries(t *testing.T) {
	dir := t.TempDir()
	hostsPath = filepath.Join(dir, "hosts")
	t.Cleanup(func() { hostsPath = "/etc/hosts" })
	if err := os.WriteFile(hostsPath, []byte("127.0.0.1 localhost\n"), 0644); err != nil {
		t.Fatal(err)
	}
	ip := netip.MustParseAddr("10.43.0.20")
	if changed, err := WriteHostsEntry("registry-token.cairn.internal", ip); err != nil || !changed {
		t.Fatalf("first write: %v %v", changed, err)
	}
	if changed, err := WriteHostsEntry("registry-token.cairn.internal", ip); err != nil || changed {
		t.Fatalf("second write must be a no-op: %v %v", changed, err)
	}
	data, _ := os.ReadFile(hostsPath)
	if string(data) != "127.0.0.1 localhost\n10.43.0.20 registry-token.cairn.internal\n" {
		t.Fatalf("hosts:\n%s", data)
	}
	if _, err := WriteHostsEntry("bad host", ip); err == nil {
		t.Fatal("invalid host accepted")
	}
}
