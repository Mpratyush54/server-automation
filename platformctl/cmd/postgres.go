package cmd

import (
	"fmt"
	"os"

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

func init() {
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
