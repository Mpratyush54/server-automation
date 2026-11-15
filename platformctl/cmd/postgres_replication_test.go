package cmd

import (
	"bytes"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestResolvePostgresReplication(t *testing.T) {
	old := postgresReplicationFlag
	t.Cleanup(func() { postgresReplicationFlag = old })
	run := func(c *config.Config, flag, input string) (string, error) {
		postgresReplicationFlag = flag
		var out bytes.Buffer
		err := resolvePostgresReplication(c, strings.NewReader(input), &out)
		return out.String(), err
	}
	load := func(env string) *config.Config {
		t.Setenv("POSTGRES_REPLICATION", env)
		return config.Load()
	}

	// --auto without flag or env: sync, no question.
	c := load("")
	c.Profile, c.NonInteractive = config.ProfileHA, true
	out, err := run(c, "", "async\n")
	if err != nil || c.PostgresReplication != "sync" || strings.Contains(out, "?") || !strings.Contains(out, "PostgreSQL replication: sync") {
		t.Fatal(err, c.PostgresReplication, out)
	}
	// --auto with the flag.
	c = load("")
	c.Profile, c.NonInteractive = config.ProfileHA, true
	if _, err := run(c, " Async ", ""); err != nil || c.PostgresReplication != "async" {
		t.Fatal(err, c.PostgresReplication)
	}
	// --auto with the environment (or saved .env).
	c = load("async")
	c.Profile, c.NonInteractive = config.ProfileHA, true
	if _, err := run(c, "", ""); err != nil || c.PostgresReplication != "async" {
		t.Fatal(err, c.PostgresReplication)
	}
	// Invalid flag or environment value stops provisioning.
	c = load("")
	c.Profile, c.NonInteractive = config.ProfileHA, true
	if _, err := run(c, "preferred", ""); err == nil || !strings.Contains(err.Error(), "--postgres-replication") {
		t.Fatal(err)
	}
	c = load("fast")
	c.Profile, c.NonInteractive = config.ProfileHA, true
	if _, err := run(c, "", ""); err == nil {
		t.Fatal("invalid POSTGRES_REPLICATION accepted")
	}
	// Interactive ha install with nothing chosen yet: asks.
	c = load("")
	c.Profile = config.ProfileHA
	out, err = run(c, "", "async\n")
	if err != nil || c.PostgresReplication != "async" || !strings.Contains(out, config.PostgresReplicationDocsURL) {
		t.Fatal(err, c.PostgresReplication, out)
	}
	// Interactive, but already saved (re-provision) or given as a flag: no question.
	c = load("sync")
	c.Profile = config.ProfileHA
	if out, err := run(c, "", "async\n"); err != nil || c.PostgresReplication != "sync" || strings.Contains(out, "?") {
		t.Fatal(err, c.PostgresReplication, out)
	}
	c = load("")
	c.Profile = config.ProfileHA
	if out, err := run(c, "async", "sync\n"); err != nil || c.PostgresReplication != "async" || strings.Contains(out, "?") {
		t.Fatal(err, c.PostgresReplication, out)
	}
	// Single-server profiles never ask and print nothing.
	c = load("")
	c.Profile = config.ProfileStandard
	if out, err := run(c, "", "async\n"); err != nil || out != "" || c.PostgresReplication != "sync" {
		t.Fatal(err, out)
	}
}

func TestPostgresReplicationCommands(t *testing.T) {
	if f := provisionCmd.Flags().Lookup("postgres-replication"); f == nil || f.DefValue != "" {
		t.Fatal("provision --postgres-replication missing")
	}
	set, _, err := rootCmd.Find([]string{"postgres", "replication", "set"})
	if err != nil || set.Name() != "set" {
		t.Fatal(err)
	}
	if err := set.Args(set, []string{}); err == nil {
		t.Fatal("set without a mode accepted")
	}
	if err := set.RunE(set, []string{"preferred"}); err == nil || !strings.Contains(err.Error(), "sync or async") {
		t.Fatal(err)
	}
	if show, _, err := rootCmd.Find([]string{"postgres", "replication", "show"}); err != nil || show.Name() != "show" {
		t.Fatal(err)
	}
	// The live ops write POSTGRES_REPLICATION to the saved config.
	if ops := pgReplicationOps(); ops.Save == nil || ops.Patch == nil || ops.StandbyNames == nil {
		t.Fatal("live replication ops incomplete")
	}
	var _ components.PGReplicationOps = pgReplicationOps()
}
