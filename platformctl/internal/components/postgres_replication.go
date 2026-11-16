package components

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// PGReplicationOps are the cluster and config operations behind
// `platformctl postgres replication set`; replaceable in tests.
type PGReplicationOps struct {
	ClusterJSON  func() ([]byte, error)
	Patch        func(patch string) error
	StandbyNames func(primary string) (string, error) // SHOW synchronous_standby_names on the primary
	Save         func(mode string) error              // POSTGRES_REPLICATION in /etc/platform/.env
	Sleep        func(time.Duration)
	Wait         time.Duration // how long to wait for PostgreSQL to pick up the change
}

// LivePGReplicationOps talks to the cluster with kubectl.
func LivePGReplicationOps(save func(mode string) error) PGReplicationOps {
	return PGReplicationOps{
		ClusterJSON: func() ([]byte, error) {
			out, err := shell.Output("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql", "-o", "json")
			return []byte(out), err
		},
		Patch: func(patch string) error {
			_, err := shell.Output("kubectl", "-n", "databases", "patch", "clusters.postgresql.cnpg.io", "postgresql", "--type", "merge", "-p", patch)
			return err
		},
		StandbyNames: func(primary string) (string, error) {
			out, err := shell.Output("kubectl", "-n", "databases", "exec", primary, "-c", "postgres", "--", "psql", "-U", "postgres", "-d", "postgres", "-Atc", "SHOW synchronous_standby_names")
			return strings.TrimSpace(out), err
		},
		Save:  save,
		Sleep: time.Sleep,
		Wait:  90 * time.Second,
	}
}

// pgReplicationPatch is the merge patch that switches spec.postgresql.synchronous.
// A null removes the stanza (asynchronous replication).
func pgReplicationPatch(mode string) (string, error) {
	var sync any
	switch mode {
	case config.PostgresReplicationSync:
		sync = pgSyncSpec()
	case config.PostgresReplicationAsync:
		sync = nil
	default:
		return "", config.ValidatePostgresReplicationMode(mode)
	}
	b, err := json.Marshal(map[string]any{"spec": map[string]any{"postgresql": map[string]any{"synchronous": sync}}})
	return string(b), err
}

// SetPostgresReplication switches the ha cluster between synchronous and
// asynchronous replication and saves the choice. CloudNativePG applies it by
// rewriting synchronous_standby_names and reloading PostgreSQL: no restart
// and no failover.
func SetPostgresReplication(cfg *config.Config, mode string, ops PGReplicationOps, w io.Writer) error {
	if err := config.ValidatePostgresReplicationMode(mode); err != nil {
		return err
	}
	mode = config.NormalizePostgresReplication(mode)
	if !cfg.IsHA() {
		return fmt.Errorf("replication mode applies to the ha profile only: single-server installs run one PostgreSQL instance with no standby")
	}
	raw, err := ops.ClusterJSON()
	if err != nil {
		return fmt.Errorf("read the PostgreSQL cluster: %w", err)
	}
	var c pgClusterState
	if err := json.Unmarshal(raw, &c); err != nil {
		return fmt.Errorf("read the PostgreSQL cluster: %w", err)
	}
	if c.Spec.Instances <= 1 {
		return fmt.Errorf("the PostgreSQL cluster has %d instance; replication needs standbys", c.Spec.Instances)
	}
	if c.replicationMode() == mode {
		fmt.Fprintf(w, "PostgreSQL replication is already %s.\n", mode)
	} else {
		patch, err := pgReplicationPatch(mode)
		if err != nil {
			return err
		}
		if err := ops.Patch(patch); err != nil {
			return fmt.Errorf("update the PostgreSQL cluster: %w", err)
		}
		fmt.Fprintf(w, "PostgreSQL replication changed to %s. PostgreSQL reloads its settings: no restart and no failover.\n", mode)
	}
	if err := ops.Save(mode); err != nil {
		return fmt.Errorf("save POSTGRES_REPLICATION: %w", err)
	}
	cfg.PostgresReplication = mode
	pgWaitForReplication(c.Status.CurrentPrimary, mode, ops, w)
	fmt.Fprintf(w, "  %s\n", pgReplicationSummary(mode))
	fmt.Fprintf(w, "  More: %s\n", config.PostgresReplicationDocsURL)
	return nil
}

// pgWaitForReplication waits until the primary reports the new
// synchronous_standby_names. A timeout is a warning: the Cluster spec is
// already changed and the operator keeps reconciling.
func pgWaitForReplication(primary, mode string, ops PGReplicationOps, w io.Writer) {
	if primary == "" || ops.StandbyNames == nil {
		return
	}
	deadline := ops.Wait
	var last string
	var lastErr error
	for waited := time.Duration(0); ; waited += 5 * time.Second {
		last, lastErr = ops.StandbyNames(primary)
		if lastErr == nil && (last != "") == (mode == config.PostgresReplicationSync) {
			if mode == config.PostgresReplicationSync {
				fmt.Fprintf(w, "  Primary %s waits for: %s\n", primary, last)
			} else {
				fmt.Fprintf(w, "  Primary %s no longer waits for a standby.\n", primary)
			}
			return
		}
		if waited >= deadline {
			break
		}
		ops.Sleep(5 * time.Second)
	}
	if lastErr != nil {
		fmt.Fprintf(w, "  WARNING: could not read synchronous_standby_names on %s: %v. Check `platformctl status` in a minute.\n", primary, lastErr)
		return
	}
	fmt.Fprintf(w, "  WARNING: the primary still reports synchronous_standby_names=%q. The operator applies the change on its next reconcile; check `platformctl status` in a minute.\n", last)
}

// PostgresReplicationStatus prints the saved and the live replication mode.
func PostgresReplicationStatus(cfg *config.Config, ops PGReplicationOps, w io.Writer) error {
	saved := config.NormalizePostgresReplication(cfg.PostgresReplication)
	if !cfg.IsHA() {
		fmt.Fprintln(w, "PostgreSQL replication: single instance (no standbys); the choice applies to the ha profile only.")
		return nil
	}
	fmt.Fprintf(w, "Saved choice (POSTGRES_REPLICATION): %s\n", saved)
	raw, err := ops.ClusterJSON()
	if err != nil {
		return fmt.Errorf("read the PostgreSQL cluster: %w", err)
	}
	var c pgClusterState
	if err := json.Unmarshal(raw, &c); err != nil {
		return fmt.Errorf("read the PostgreSQL cluster: %w", err)
	}
	fmt.Fprintf(w, "Running cluster: %s\n", c.replicationSummary())
	if live := c.replicationMode(); live != "" && live != saved {
		fmt.Fprintf(w, "WARNING: the cluster runs %s but %s is saved; run: sudo platformctl postgres replication set %s\n", live, saved, saved)
	}
	fmt.Fprintln(w, "\nChoices:")
	config.PostgresReplicationChoices(w)
	fmt.Fprintln(w, "Change it: sudo platformctl postgres replication set sync|async")
	return nil
}
