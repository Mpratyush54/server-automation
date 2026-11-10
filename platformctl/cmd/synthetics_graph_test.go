package cmd

import (
	"slices"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// #42: the synthetics step runs after telemetry and only on the full profile, so
// minimal/standard installs are unchanged.
func TestSyntheticsStepFullProfileAfterTelemetry(t *testing.T) {
	for _, profile := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull} {
		c := allOn()
		if err := c.ApplyProfile(profile); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, step := range provisionGraph(c) {
			if step.name != "synthetics" {
				continue
			}
			found = true
			if step.skip != (profile != config.ProfileFull) {
				t.Fatalf("profile %s: synthetics skip %v", profile, step.skip)
			}
			if !slices.Contains(step.deps, "telemetry") {
				t.Fatal("synthetics must run after telemetry")
			}
		}
		if !found {
			t.Fatal("synthetics step missing")
		}
	}
}
