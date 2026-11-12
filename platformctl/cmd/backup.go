package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"filippo.io/age"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var backupAll bool
var backupConfigPath, backupTarget, restoreID, restoreComponent string
var restoreConfirm bool
var restorePITR string

func backupSettings() (backup.Config, error) {
	c, e := backup.ReadConfig(backupConfigPath)
	if e != nil {
		return c, e
	}
	if backupTarget != "" {
		c.Target = backupTarget
	}
	return c, c.Validate()
}
func warnLocal(c backup.Config) {
	t, _ := backup.ParseTarget(c.Target)
	if !t.Remote {
		fmt.Fprintln(os.Stderr, "WARNING: local backups do not protect against server or disk loss; use an off-site S3/R2/B2 target.")
	} else {
		fmt.Fprintln(os.Stderr, "Ensure the configured S3 alias is off-site; bundled MinIO does not protect against node loss.")
	}
}
func hostKubeconfig() {
	if os.Getenv("KUBECONFIG") == "" {
		os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
	}
}

func captureTools(c backup.Config) []string {
	t, _ := backup.ParseTarget(c.Target)
	tools := backup.RequiredTools(c.Components, t.Remote, false)
	if _, e := os.Stat("/var/lib/rancher/k3s/server/db/etcd"); e == nil {
		// embedded etcd: snapshots use `k3s etcd-snapshot`, not sqlite3
		out := tools[:0]
		for _, v := range tools {
			if v != "sqlite3" {
				out = append(out, v)
			}
		}
		tools = out
	}
	return tools
}

func runFullBackup() error {
	c, e := backupSettings()
	if e != nil {
		return e
	}
	warnLocal(c)
	if e = backup.CheckTools(captureTools(c)); e != nil {
		return e
	}
	unlock, e := state.AcquireLock("backup")
	if e != nil {
		return e
	}
	defer unlock()
	start := time.Now()
	m, e := backup.Create(c, Version, backup.HostDriver{MinioAlias: c.MinioAlias})
	if se := backup.PublishStatus("backup", m.ID, start, m, e); se != nil {
		fmt.Fprintln(os.Stderr, "backup status publication failed:", se)
	}
	if e != nil {
		return e
	}
	fmt.Println(m.ID)
	return nil
}

var provisionRestoreFrom, provisionRestoreID string

// wrapProvisionRestore adds `provision --restore-from <target> <id>`: the age
// identity is read from stdin BEFORE provisioning (so a bad key fails fast),
// kept in memory only, and used for a full logical restore once the fresh
// cluster is healthy.
func wrapProvisionRestore() {
	provision := provisionCmd.RunE
	provisionCmd.Args = cobra.MaximumNArgs(1)
	provisionCmd.Use = "provision [backup-id]"
	provisionCmd.RunE = func(cmd *cobra.Command, args []string) error {
		if provisionRestoreFrom == "" {
			if len(args) > 0 || provisionRestoreID != "" {
				return fmt.Errorf("a backup ID needs --restore-from <target>")
			}
			return provision(cmd, args)
		}
		id := provisionRestoreID
		if len(args) == 1 {
			if id != "" && id != args[0] {
				return fmt.Errorf("conflicting backup IDs %q and %q", id, args[0])
			}
			id = args[0]
		}
		if id == "" {
			return fmt.Errorf("--restore-from needs a backup ID (positional or --restore-id); list them with `platformctl backup list --target ...`")
		}
		if !cfg.NonInteractive {
			return fmt.Errorf("--restore-from requires --auto: stdin carries the age identity, not interactive answers")
		}
		if _, e := backup.ParseTarget(provisionRestoreFrom); e != nil {
			return e
		}
		identity, e := readIdentity(cmd.InOrStdin())
		if e != nil {
			return e
		}
		defer clear(identity)
		if e = provision(cmd, args[:0]); e != nil {
			return e
		}
		color.Cyan("\n  ■ Restoring backup %s from %s", id, provisionRestoreFrom)
		return runRestore(provisionRestoreFrom, id, "", identity)
	}
	provisionCmd.Flags().StringVar(&provisionRestoreFrom, "restore-from", "", "after provisioning, restore a backup from this target (file:///... or s3://mc-alias/bucket/prefix); age identity on stdin, requires --auto")
	provisionCmd.Flags().StringVar(&provisionRestoreID, "restore-id", "", "backup ID to restore with --restore-from (or pass it as the positional argument)")
}

func init() {
	wrapProvisionRestore()
	backupCmd.Short = "Back up credentials locally, or all configured components encrypted with --all"
	backupCmd.Args = cobra.NoArgs
	backupCmd.PersistentFlags().StringVar(&backupConfigPath, "backup-config", "/etc/platform/backup.json", "backup configuration (contains only the public age recipient)")
	backupCmd.PersistentFlags().StringVar(&backupTarget, "target", "", "override configured file:// or s3://mc-alias/bucket/prefix target")
	backupCmd.Flags().BoolVar(&backupAll, "all", false, "create encrypted component backup and enforce retention")
	backupCmd.AddCommand(&cobra.Command{Use: "list", Short: "List complete backups on the target", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		c, e := backupSettings()
		if e != nil {
			return e
		}
		t, e := backup.ParseTarget(c.Target)
		if e != nil {
			return e
		}
		items, e := (backup.Store{Target: t}).List()
		if e != nil {
			return e
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(items)
	}})
	var recipient string
	var componentNames []string
	var keep backup.Retention
	initCmd := &cobra.Command{Use: "init", Short: "Configure backups; print a new private identity once without saving it", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		var private string
		if recipient == "" {
			key, e := age.GenerateX25519Identity()
			if e != nil {
				return e
			}
			recipient = key.Recipient().String()
			private = key.String()
		}
		if e := backup.ValidateRecipient(recipient); e != nil {
			return e
		}
		c := backup.Config{Target: backupTarget, Recipient: recipient, Retention: keep, Components: componentNames}
		if e := c.Validate(); e != nil {
			return e
		}
		warnLocal(c)
		b, e := json.MarshalIndent(c, "", "  ")
		if e != nil {
			return e
		}
		if e = os.MkdirAll(filepath.Dir(backupConfigPath), 0700); e != nil {
			return e
		}
		f, e := os.OpenFile(backupConfigPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		_, e = f.Write(b)
		ce := f.Close()
		if e != nil {
			return e
		}
		if ce != nil {
			return ce
		}
		if private != "" {
			_, e = fmt.Fprintln(cmd.OutOrStdout(), "Save this identity OFF the server. It will not be shown again:\n"+private)
			return e
		}
		return nil
	}}
	initCmd.Flags().IntVar(&keep.Daily, "keep-daily", 7, "retention: newest backup of each of the last N days (>= 1)")
	initCmd.Flags().IntVar(&keep.Weekly, "keep-weekly", 4, "retention: newest backup of each of the last M ISO weeks")
	initCmd.Flags().IntVar(&keep.Monthly, "keep-monthly", 12, "retention: newest backup of each of the last K months")
	initCmd.Flags().StringVar(&recipient, "recipient", "", "existing age public recipient; recommended to generate keys off-server")
	initCmd.Flags().StringSliceVar(&componentNames, "components", []string{"config", "postgres", "mongo", "redis", "minio", "k3s"}, "installed components to protect (config,postgres required)")
	backupCmd.AddCommand(initCmd)
	schedule := &cobra.Command{Use: "schedule", Short: "Install the opt-in nightly low-priority backup CronJob", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		c, e := backupSettings()
		if e != nil {
			return e
		}
		warnLocal(c)
		if backupTarget != "" || backupConfigPath != "/etc/platform/backup.json" {
			return fmt.Errorf("schedule uses /etc/platform/backup.json; save target overrides there first")
		}
		if _, e = os.Stat("/usr/local/bin/platformctl"); e != nil {
			return fmt.Errorf("the CronJob runs /usr/local/bin/platformctl on the host: install the binary there first")
		}
		if e = backup.CheckTools(captureTools(c)); e != nil {
			return e
		}
		if _, e = shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, backup.ScheduleYAML); e != nil {
			return e
		}
		color.Green("  ✓ CronJob platform-backup-nightly installed (02:15 UTC)")
		// Alert rules only where the monitoring stack (and its CRDs) exist.
		if shell.RunSilent("kubectl", "get", "crd", "prometheusrules.monitoring.coreos.com") == nil {
			if _, e = shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, backup.AlertsYAML); e != nil {
				return fmt.Errorf("apply backup alert rules: %w", e)
			}
			color.Green("  ✓ PrometheusRule monitoring/platform-backups installed")
		} else {
			color.Yellow("  · monitoring not installed: backup failures are reported via portal notifications only")
		}
		return nil
	}}
	backupCmd.AddCommand(schedule)
	restore := &cobra.Command{Use: "restore", Short: "Restore into a provisioned server; reads the age identity from stdin", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		if !restoreConfirm {
			return fmt.Errorf("restore replaces data: stop project workloads, then pass --confirm")
		}
		if restorePITR != "" {
			if !cfg.IsHA() {
				return fmt.Errorf("--pitr requires the ha profile")
			}
			target, err := time.Parse(time.RFC3339, restorePITR)
			if err != nil {
				return fmt.Errorf("--pitr must be RFC3339: %w", err)
			}
			unlock, err := state.AcquireLock("restore-pitr")
			if err != nil {
				return err
			}
			defer unlock()
			return components.RestorePostgresPITR(cfg, target)
		}
		if restoreID == "" {
			return fmt.Errorf("--from backup ID is required")
		}
		identity, e := readIdentity(cmd.InOrStdin())
		if e != nil {
			return e
		}
		defer clear(identity)
		return runRestore(backupTarget, restoreID, restoreComponent, identity)
	}}
	restore.Flags().StringVar(&restorePITR, "pitr", "", "HA PostgreSQL recovery target (RFC3339); does not read an age identity")
	restore.Flags().StringVar(&backupConfigPath, "backup-config", "/etc/platform/backup.json", "backup config")
	restore.Flags().StringVar(&backupTarget, "target", "", "target override")
	restore.Flags().StringVar(&restoreID, "from", "", "backup ID")
	restore.Flags().StringVar(&restoreComponent, "component", "", "restore one component (default: logical data/config; k3s is offline recovery only)")
	restore.Flags().BoolVar(&restoreConfirm, "confirm", false, "confirm writers are stopped and existing data may be replaced")
	rootCmd.AddCommand(restore)
	restore.PersistentPreRun = func(*cobra.Command, []string) { hostKubeconfig() }
	backupCmd.PersistentPreRun = func(*cobra.Command, []string) { hostKubeconfig() }
	var testID string
	testCmd := &cobra.Command{Use: "restore-test", Short: "Decrypt a backup from stdin identity and test Postgres in a disposable database", Args: cobra.NoArgs, RunE: func(cmd *cobra.Command, args []string) error {
		c, e := backupSettings()
		if e != nil {
			return e
		}
		id := testID
		if id == "" {
			t, e := backup.ParseTarget(c.Target)
			if e != nil {
				return e
			}
			items, e := (backup.Store{Target: t}).List()
			if e != nil {
				return e
			}
			for _, m := range items {
				if id == "" || m.ID > id {
					id = m.ID
				}
			}
			if id == "" {
				return fmt.Errorf("no complete backups")
			}
		}
		key, e := io.ReadAll(io.LimitReader(cmd.InOrStdin(), 64<<10))
		if e != nil {
			return e
		}
		defer clear(key)
		unlock, e := state.AcquireLock("restore-test")
		if e != nil {
			return e
		}
		defer unlock()
		start := time.Now()
		e = backup.TestPostgres(c.Target, id, key)
		if se := backup.PublishStatus("restore-test", id, start, backup.Manifest{}, e); se != nil {
			fmt.Fprintln(os.Stderr, "restore-test status publication failed:", se)
		}
		return e
	}}
	testCmd.Flags().StringVar(&testID, "from", "", "backup ID (default latest complete)")
	backupCmd.AddCommand(testCmd)
}

// readIdentity reads and validates an age identity from r (stdin). It is held
// only in memory; callers clear it when done.
func readIdentity(r io.Reader) ([]byte, error) {
	identity, e := io.ReadAll(io.LimitReader(r, 64<<10))
	if e != nil {
		return nil, e
	}
	ids, e := age.ParseIdentities(bytes.NewReader(identity))
	if e != nil || len(ids) == 0 {
		clear(identity)
		return nil, fmt.Errorf("stdin must contain the backup's age identity (AGE-SECRET-KEY-...)")
	}
	return identity, nil
}

// restoreConfig uses /etc/platform/backup.json when present; on a fresh VM an
// explicit --target is enough (the public config itself is restored).
func restoreConfig(target string) (backup.Config, error) {
	c, e := backup.ReadConfig(backupConfigPath)
	if e != nil {
		if target == "" || !os.IsNotExist(e) {
			return c, fmt.Errorf("read %s (or pass --target): %w", backupConfigPath, e)
		}
		c = backup.Config{}
	}
	if target != "" {
		c.Target = target
	}
	if _, e = backup.ParseTarget(c.Target); e != nil {
		return c, e
	}
	return c, nil
}

func runRestore(target, id, component string, identity []byte) error {
	hostKubeconfig()
	c, e := restoreConfig(target)
	if e != nil {
		return e
	}
	t, _ := backup.ParseTarget(c.Target)
	comps := []string{"config", "postgres", "mongo", "redis", "minio"}
	if component != "" {
		comps = []string{component}
	}
	if e = backup.CheckTools(backup.RequiredTools(comps, t.Remote, true)); e != nil {
		return e
	}
	unlock, e := state.AcquireLock("restore")
	if e != nil {
		return e
	}
	defer unlock()
	if e = backup.Restore(c.Target, id, component, identity, backup.HostDriver{MinioAlias: c.MinioAlias}); e != nil {
		return fmt.Errorf("%w; if credentials no longer match after a partial restore, run `sudo platformctl recover` and retry", e)
	}
	color.Green("  ✓ Restored backup %s", id)
	return nil
}
