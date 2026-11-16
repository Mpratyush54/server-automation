package cmd

import (
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"testing"
)

func TestBuildsStepAfterStorageAndIngress(t *testing.T) {
	for _, profile := range config.Profiles {
		found := false
		for _, step := range provisionGraph(&config.Config{Profile: profile, BuildsEnabled: true}) {
			if step.name != "builds" {
				continue
			}
			found = true
			if step.skip != (profile == config.ProfileMinimal) {
				t.Fatalf("%s build gate", profile)
			}
			deps := map[string]bool{}
			for _, dep := range step.deps {
				deps[dep] = true
			}
			if !deps["storage-scoped"] || !deps["ingress"] || !deps["platform"] {
				t.Fatal("build dependencies missing")
			}
		}
		if !found {
			t.Fatal("builds step missing")
		}
	}
}
