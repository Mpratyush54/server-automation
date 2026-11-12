package cmd

import (
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/runner"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"path/filepath"
	"slices"
	"testing"
)

func TestLonghornGraph(t *testing.T) {
	for _, profile := range config.Profiles {
		c := allOn()
		c.Profile = profile
		graph := provisionGraph(c)
		if graph[0].name != "longhorn" || len(graph[0].deps) != 0 || graph[0].skip != (profile != config.ProfileHA) {
			t.Fatalf("%s first step: %+v", profile, graph[0])
		}
		if err := runner.Validate(toNodes(graph)); err != nil {
			t.Fatal(err)
		}
		for _, s := range graph {
			if slices.Contains([]string{"postgresql", "mongodb", "redis", "minio", "monitoring", "portainer", "platform"}, s.name) && !slices.Contains(s.deps, "longhorn") {
				t.Errorf("%s missing longhorn dep", s.name)
			}
			if s.name == "longhorn-monitoring" {
				if !slices.Equal(s.deps, []string{"longhorn", "monitoring"}) || !s.warnOnly || s.skip != (profile != config.ProfileHA) {
					t.Errorf("%s: %+v", profile, s)
				}
			}
		}
	}
	c := &config.Config{Profile: config.ProfileHA}
	for _, s := range provisionGraph(c) {
		if s.name == "longhorn-monitoring" && !s.skip {
			t.Error("monitoring disabled")
		}
	}
}

func TestLonghornUpgradePlan(t *testing.T) {
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	defer state.SetPath(state.DefaultPath)
	if err := state.MarkDone("longhorn"); err != nil {
		t.Fatal(err)
	}
	for _, profile := range config.Profiles {
		c := &config.Config{Profile: profile}
		p := planSteps(componentPlan(c))
		ch, exists := p["longhorn"]
		if exists != (profile == config.ProfileHA) {
			t.Errorf("%s: longhorn present %v", profile, exists)
		}
		if exists && (ch.Action != "re-apply" || ch.Restarts != reappliedSteps["longhorn"]) {
			t.Errorf("%+v", ch)
		}
	}
}
