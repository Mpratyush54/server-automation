package components

import (
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestAPIAffinityOnlyForHA(t *testing.T) {
	for _, p := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull} {
		if got := apiAffinityYAML(&config.Config{Profile: p}); got != "" {
			t.Errorf("%s profile must keep the manifest unchanged, got:\n%s", p, got)
		}
	}
	got := apiAffinityYAML(&config.Config{Profile: config.ProfileHA})
	for _, want := range []string{"podAntiAffinity:", "preferredDuringSchedulingIgnoredDuringExecution:",
		"topologyKey: kubernetes.io/hostname", "app: platform-api"} {
		if !strings.Contains(got, want) {
			t.Errorf("ha affinity missing %q:\n%s", want, got)
		}
	}
	// Spliced into the pod spec at six-space indentation and newline-terminated.
	if !strings.HasPrefix(got, "      affinity:\n") || !strings.HasSuffix(got, "\n") {
		t.Errorf("bad indentation/termination:\n%q", got)
	}
}
