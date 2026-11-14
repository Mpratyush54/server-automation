package k3s

import (
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
