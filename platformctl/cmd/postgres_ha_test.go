package cmd

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/runner"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func TestPostgresHAGraphAndUpgrade(t *testing.T) {
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	defer state.SetPath(state.DefaultPath)
	if err := state.MarkDone("postgresql"); err != nil {
		t.Fatal(err)
	}
	if err := state.MarkDone("postgresql-backup"); err != nil {
		t.Fatal(err)
	}
	for _, profile := range config.Profiles {
		c := allOn()
		c.Profile = profile
		graph := provisionGraph(c)
		if err := runner.Validate(toNodes(graph)); err != nil {
			t.Fatal(err)
		}
		for _, step := range graph {
			switch step.name {
			case "postgresql-backup":
				if !slices.Equal(step.deps, []string{"postgresql", "minio", "platform"}) || step.skip != !c.IsHA() {
					t.Fatal(step)
				}
			case "postgresql-monitoring":
				if !slices.Equal(step.deps, []string{"postgresql", "monitoring"}) || step.skip != !c.IsHA() || !step.warnOnly {
					t.Fatal(step)
				}
			}
		}
		for _, r := range components.DatabaseReleases(c) {
			if c.IsHA() && r.Step == "postgresql" {
				t.Fatal("Bitnami release on ha")
			}
		}
		if c.IsHA() {
			p := planSteps(componentPlan(c))
			if p["postgresql"].Action != "re-apply" || p["postgresql-backup"].Action != "re-apply" {
				t.Fatal(p)
			}
		}
	}
	c := &config.Config{Profile: config.ProfileHA}
	for _, step := range provisionGraph(c) {
		if step.name == "postgresql-monitoring" && !step.skip {
			t.Fatal("monitoring must skip")
		}
	}
}

type pitrNoStdin struct{}

func (pitrNoStdin) Read([]byte) (int, error) { panic("PITR must not read stdin") }

func TestPITRFlagsDoNotReadAgeIdentity(t *testing.T) {
	state.SetLockPath(filepath.Join(t.TempDir(), "lock"))
	defer state.SetLockPath(state.DefaultLockPath)
	oldCfg, oldPITR, oldID, oldConfirm := cfg, restorePITR, restoreID, restoreConfirm
	defer func() { cfg, restorePITR, restoreID, restoreConfirm = oldCfg, oldPITR, oldID, oldConfirm }()
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	defer state.SetPath(state.DefaultPath)
	for _, cmd := range rootCmd.Commands() {
		if cmd.Name() == "restore" {
			cmd.SetIn(pitrNoStdin{})
			defer cmd.SetIn(nil)
			for _, tc := range []struct {
				profile, target string
				confirm         bool
				want            string
			}{
				{config.ProfileHA, "2026-11-01T00:00:00Z", false, "--confirm"},
				{config.ProfileFull, "2026-11-01T00:00:00Z", true, "ha profile"},
				{config.ProfileHA, "bad timestamp", true, "RFC3339"},
				{config.ProfileHA, "9999-11-01T00:00:00Z", true, "past"},
			} {
				cfg = &config.Config{Profile: tc.profile}
				restorePITR, restoreConfirm, restoreID = tc.target, tc.confirm, "ignored-for-pitr"
				if err := cmd.RunE(cmd, nil); err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("%+v: %v", tc, err)
				}
			}
			return
		}
	}
	t.Fatal("restore command missing")
}
