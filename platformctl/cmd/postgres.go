package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// `platformctl postgres migrate` moves a Bitnami PostgreSQL release to
// CloudNativePG (#180) so the install gets point-in-time recovery (#186).
var postgresCmd = &cobra.Command{Use: "postgres", Short: "PostgreSQL maintenance"}

var pgMigrateDryRun, pgMigrateConfirm, pgMigrateRollback bool

// pgMigrateOps is replaceable in tests.
var pgMigrateOps = func() components.PGMigrateOps {
	var full func() error
	if _, err := os.Stat(backupConfigPath); err == nil {
		full = runFullBackup
	}
	// Only the engine and the adopted superuser password change.
	return components.LivePGMigrateOps(full, func(c *config.Config) error {
		if err := config.UpsertEnvKey(envFilePath, "POSTGRES_ENGINE", c.PostgresEngine); err != nil {
			return err
		}
		return config.UpsertEnvKey(envFilePath, "POSTGRES_PASSWORD", c.PostgresPassword)
	})
}

// postgresReplicationFlag is `provision --postgres-replication`.
var postgresReplicationFlag string

// pgReplicationOps is replaceable in tests.
var pgReplicationOps = func() components.PGReplicationOps {
	return components.LivePGReplicationOps(func(mode string) error {
		return config.UpsertEnvKey(envFilePath, "POSTGRES_REPLICATION", mode)
	})
}

// resolvePostgresReplication settles POSTGRES_REPLICATION before provision
// changes anything: the flag wins, then the environment or saved .env; an
// interactive ha install with neither asks. Single-server profiles ignore it.
func resolvePostgresReplication(c *config.Config, in io.Reader, out io.Writer) error {
	if strings.TrimSpace(postgresReplicationFlag) != "" {
		if err := config.ValidatePostgresReplicationMode(postgresReplicationFlag); err != nil {
			return fmt.Errorf("--postgres-replication: %w", err)
		}
		c.PostgresReplication = config.NormalizePostgresReplication(postgresReplicationFlag)
	} else if c.IsHA() && !c.NonInteractive && !c.PostgresReplicationChosen() {
		c.PromptPostgresReplication(in, out)
	}
	if err := c.ValidatePostgresReplication(); err != nil {
		return err
	}
	c.PostgresReplication = config.NormalizePostgresReplication(c.PostgresReplication)
	if c.IsHA() {
		fmt.Fprintf(out, "  · PostgreSQL replication: %s (change later: sudo platformctl postgres replication set sync|async)\n", c.PostgresReplication)
	}
	return nil
}

func init() {
	replication := &cobra.Command{
		Use:   "replication",
		Short: "Show or change synchronous/asynchronous PostgreSQL replication (ha profile)",
		Long: `Shows how PostgreSQL copies writes to the standbys on the ha profile.

  sync   every write waits for a second server: no confirmed write is lost when
         a server dies. Writes pause during failover: about 1 to 2 minutes
         when a server is lost.
  async  writes are confirmed right away, without waiting for a standby.
         Failover also takes about 1 to 2 minutes when a server is lost, and
         the last writes confirmed before the failure can be lost.

Explainer: ` + config.PostgresReplicationDocsURL,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			hostKubeconfig()
			return components.PostgresReplicationStatus(cfg, pgReplicationOps(), cmd.OutOrStdout())
		},
	}
	replication.AddCommand(&cobra.Command{
		Use:       "set sync|async",
		Short:     "Switch PostgreSQL replication live (no restart) and save the choice",
		Args:      cobra.ExactArgs(1),
		ValidArgs: []string{config.PostgresReplicationSync, config.PostgresReplicationAsync},
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := config.ValidatePostgresReplicationMode(args[0]); err != nil {
				return err
			}
			hostKubeconfig()
			unlock, err := state.AcquireLock("postgres-replication")
			if err != nil {
				return err
			}
			defer unlock()
			return components.SetPostgresReplication(cfg, args[0], pgReplicationOps(), cmd.OutOrStdout())
		},
	})
	replication.AddCommand(&cobra.Command{
		Use:   "show",
		Short: "Show the saved and the running replication mode",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			hostKubeconfig()
			return components.PostgresReplicationStatus(cfg, pgReplicationOps(), cmd.OutOrStdout())
		},
	})
	postgresCmd.AddCommand(replication)
	provisionCmd.Flags().StringVar(&postgresReplicationFlag, "postgres-replication", "",
		"ha profile: sync (default; no confirmed write lost, writes pause about 1-2 minutes when a server is lost) or async (writes do not wait for a standby; the last confirmed writes can be lost); env POSTGRES_REPLICATION")

	migrate := &cobra.Command{
		Use:   "migrate",
		Short: "Move the Bitnami PostgreSQL release to CloudNativePG (point-in-time recovery); resumable",
		Long: `Moves PostgreSQL from the Bitnami release to a CloudNativePG cluster so
point-in-time recovery works. Takes a pre-migration backup, stops the platform
API and project database logins, dumps every database, keeps the old volume for
rollback, restores into CloudNativePG, verifies, and turns on WAL archiving.

Every finished step is recorded: re-run the same command to continue after a
failure. --rollback returns to the Bitnami release on the kept volume.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			hostKubeconfig()
			if !pgMigrateDryRun && !pgMigrateConfirm {
				return fmt.Errorf("the migration stops the platform and project database connections for a few minutes: stop project workloads that write to PostgreSQL, then pass --confirm (or --dry-run to see the plan)")
			}
			unlock, err := state.AcquireLock("postgres-migrate")
			if err != nil {
				return err
			}
			defer unlock()
			return components.MigratePostgresToCNPG(cfg, pgMigrateOps(), components.PGMigrateOptions{DryRun: pgMigrateDryRun, Rollback: pgMigrateRollback, Out: cmd.OutOrStdout()})
		},
	}
	migrate.Flags().BoolVar(&pgMigrateDryRun, "dry-run", false, "print the plan and check the current databases; change nothing")
	migrate.Flags().BoolVar(&pgMigrateConfirm, "confirm", false, "confirm the downtime window")
	migrate.Flags().BoolVar(&pgMigrateRollback, "rollback", false, "return to the Bitnami release on the kept volume")
	postgresCmd.AddCommand(migrate)
	rootCmd.AddCommand(postgresCmd)
}
