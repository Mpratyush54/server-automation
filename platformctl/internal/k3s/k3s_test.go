package k3s

import (
	"strings"
	"testing"
)

func TestRegistriesYAML(t *testing.T) {
	if RegistriesYAML("") != "" {
		t.Fatal("no token must produce no registries.yaml")
	}
	got := RegistriesYAML(`gh"o_x`)
	for _, want := range []string{`"ghcr.io":`, "username: oauth2", `password: "gh\"o_x"`} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}
