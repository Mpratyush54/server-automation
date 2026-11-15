package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// External backup target (#186): provision flags, `backup target set|show|test`
// and the resolution of the "external" archive target.

var (
	localBackupsFlag    bool
	backupEndpointFlag  string
	backupBucketFlag    string
	backupRegionFlag    string
	backupPrefixFlag    string
	backupRecipientFlag string
)

// Replaceable in tests.
var (
	probeBackupTarget = components.ProbeBackupTarget
	promptBackup      = func(c *config.Config) { c.PromptBackupTarget() }
)

func applyBackupFlags(c *config.Config) {
	b := &c.Backup
	if localBackupsFlag {
		b.LocalOnly = true
	}
	for _, f := range []struct {
		flag string
		dst  *string
	}{{backupEndpointFlag, &b.Endpoint}, {backupBucketFlag, &b.Bucket}, {backupRegionFlag, &b.Region}, {backupPrefixFlag, &b.Prefix}, {backupRecipientFlag, &b.AgeRecipient}} {
		if strings.TrimSpace(f.flag) != "" {
			*f.dst = strings.TrimSpace(f.flag)
		}
	}
}

// resolveBackupTarget settles where backups go before provisioning changes
// anything: an external target is validated with a write/read/delete probe;
// local-only needs an explicit choice on fresh installs.
func resolveBackupTarget(c *config.Config) error {
	applyBackupFlags(c)
	fresh := !state.IsDone("postgresql")
	if !c.NonInteractive && c.Backup.Mode == "" && !c.Backup.LocalOnly && c.Backup.Bucket == "" {
		promptBackup(c)
	}
	if err := c.ResolveBackupChoice(fresh); err != nil {
		return err
	}
	if c.Backup.Mode != config.BackupModeExternal {
		if c.Backup.Mode == "" {
			color.Yellow("  ⚠ No off-site backup target is configured. %s", components.LocalOnlyWarning)
		} else {
			color.Yellow("  ⚠ Local-only backups chosen. %s", components.LocalOnlyWarning)
		}
		return nil
	}
	for attempt := 1; ; attempt++ {
		t := components.BackupTargetFromConfig(c)
		if err := t.ValidateSettings(); err != nil {
			return err
		}
		if !c.Backup.HasCredentials() {
			if fresh {
				return fmt.Errorf("the backup target needs credentials: set BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY in the environment (never on the command line)")
			}
			// Re-provision: the credentials stored in the cluster are reused.
			color.Cyan("  · backup target %s (stored credentials)", t.Describe())
			return nil
		}
		color.Cyan("  · checking the backup target %s (write, read back, delete)...", t.Describe())
		err := probeBackupTarget(t)
		if err == nil {
			color.Green("  ✓ Backup target works: %s", t.Describe())
			return nil
		}
		if c.NonInteractive || attempt >= 3 {
			return err
		}
		color.Red("  ✗ %v", err)
		c.Backup.Mode = ""
		promptBackup(c)
		if err := c.ResolveBackupChoice(fresh); err != nil {
			return err
		}
		if c.Backup.Mode != config.BackupModeExternal {
			return nil
		}
	}
}

const defaultLocalArchiveTarget = "file:///var/lib/platform/encrypted-backups"

// saveBackupEnv updates only the backup keys in /etc/platform/.env (never
// the credentials), leaving every other saved setting untouched.
func saveBackupEnv(c *config.Config) error {
	b := c.Backup
	for _, kv := range [][2]string{{"BACKUP_MODE", b.Mode}, {"BACKUP_S3_ENDPOINT", b.Endpoint}, {"BACKUP_S3_BUCKET", b.Bucket}, {"BACKUP_S3_REGION", b.Region}, {"BACKUP_S3_PREFIX", b.Prefix}} {
		if strings.ContainsAny(kv[1], "\r\n") {
			return fmt.Errorf("backup settings cannot contain line breaks")
		}
		if err := config.UpsertEnvKey(envFilePath, kv[0], kv[1]); err != nil {
			return err
		}
	}
	return nil
}

// defaultArchiveTarget is the backup.json target for this install.
func defaultArchiveTarget(c *config.Config) string {
	if c.BackupExternal() {
		return backup.ExternalTargetKeyword
	}
	return defaultLocalArchiveTarget
}

// resolveArchiveTarget turns "external" into the target's archive URL and
// loads credentials for the built-in S3 client.
func resolveArchiveTarget(raw string) (string, error) {
	if raw != backup.ExternalTargetKeyword {
		return raw, nil
	}
	t, err := components.ReadBackupTarget()
	if err != nil {
		return "", err
	}
	backup.UseExternalTarget(t)
	return t.ArchiveTarget(), nil
}

// finishBackupSetup writes backup.json and the nightly schedule when an age
// recipient was given, and otherwise prints the next step.
func finishBackupSetup(w io.Writer, c *config.Config) {
	if _, err := os.Stat(backupConfigPath); err == nil {
		return
	}
	if c.Backup.AgeRecipient == "" {
		fmt.Fprintln(w, "\n  Encrypted nightly backups (MongoDB, Redis, files, settings and passwords) are not set up yet.")
		fmt.Fprintln(w, "  Make a key pair on your own computer (age-keygen), then on this server:")
		fmt.Fprintln(w, "    sudo platformctl backup init --recipient age1...")
		fmt.Fprintln(w, "    sudo platformctl backup schedule")
		return
	}
	bc := backup.Config{Target: defaultArchiveTarget(c), Recipient: c.Backup.AgeRecipient, Retention: backup.Retention{Daily: 7, Weekly: 4, Monthly: 12},
		Components: []string{"config", "postgres", "mongo", "redis", "minio", "k3s"}}
	if err := writeBackupConfig(bc); err != nil {
		color.Yellow("  ⚠ encrypted backups not configured: %v", err)
		return
	}
	color.Green("  ✓ Encrypted backups configured (%s)", backupConfigPath)
	if err := installSchedule(bc); err != nil {
		color.Yellow("  ⚠ nightly backup schedule not installed: %v (run: sudo platformctl backup schedule)", err)
	}
}

func writeBackupConfig(c backup.Config) error {
	if err := backup.ValidateRecipient(c.Recipient); err != nil {
		return fmt.Errorf("invalid age recipient: %w", err)
	}
	if err := c.Validate(); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(backupConfigPath), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(backupConfigPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if ce := f.Close(); err == nil {
		err = ce
	}
	return err
}

// readCredentials gets the access key and secret: environment first, then two
// lines on stdin (--credentials-stdin), then a hidden prompt on a terminal.
func readCredentials(c *config.Config, stdin io.Reader, fromStdin bool) error {
	b := &c.Backup
	if b.HasCredentials() {
		return nil
	}
	if fromStdin {
		sc := bufio.NewScanner(io.LimitReader(stdin, 16<<10))
		var lines []string
		for sc.Scan() && len(lines) < 2 {
			if l := strings.TrimSpace(sc.Text()); l != "" {
				lines = append(lines, l)
			}
		}
		if len(lines) != 2 {
			return fmt.Errorf("--credentials-stdin expects two lines: the access key ID, then the secret access key")
		}
		b.AccessKey, b.SecretKey = lines[0], lines[1]
		return nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("set BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY, or pass --credentials-stdin")
	}
	for _, f := range []struct {
		label string
		dst   *string
	}{{"Access key ID", &b.AccessKey}, {"Secret access key", &b.SecretKey}} {
		fmt.Print(color.CyanString("  ? " + f.label + ": "))
		v, err := term.ReadPassword(int(os.Stdin.Fd()))
		fmt.Println()
		if err != nil {
			return err
		}
		*f.dst = strings.TrimSpace(string(v))
	}
	return nil
}

func init() {
	provisionCmd.Flags().BoolVar(&localBackupsFlag, "local-backups", false, "keep backups only on this server (not recommended; a warning stays until a target is set)")
	provisionCmd.Flags().StringVar(&backupEndpointFlag, "backup-endpoint", "", "backup target S3 endpoint URL (empty = AWS S3; env BACKUP_S3_ENDPOINT)")
	provisionCmd.Flags().StringVar(&backupBucketFlag, "backup-bucket", "", "backup target bucket (env BACKUP_S3_BUCKET); credentials only via BACKUP_S3_ACCESS_KEY/BACKUP_S3_SECRET_KEY")
	provisionCmd.Flags().StringVar(&backupRegionFlag, "backup-region", "", "backup target region (env BACKUP_S3_REGION, default us-east-1)")
	provisionCmd.Flags().StringVar(&backupPrefixFlag, "backup-prefix", "", "folder inside the bucket (env BACKUP_S3_PREFIX)")
	provisionCmd.Flags().StringVar(&backupRecipientFlag, "backup-recipient", "", "age public key for encrypted nightly archives (env BACKUP_AGE_RECIPIENT)")

	targetCmd := &cobra.Command{Use: "target", Short: "Show, change or test the off-site backup target"}
	var setLocal, credsStdin bool
	var setEndpoint, setBucket, setRegion, setPrefix string
	set := &cobra.Command{Use: "set", Short: "Set the off-site backup target (credentials from the environment, stdin or a prompt)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			unlock, err := state.AcquireLock("backup-target")
			if err != nil {
				return err
			}
			defer unlock()
			if setLocal {
				if setBucket != "" {
					return fmt.Errorf("choose one: --local or --bucket")
				}
				cfg.Backup = config.BackupSettings{Mode: config.BackupModeLocal, LocalOnly: true}
				if err := components.ApplyLocalBackupChoice(); err != nil {
					return err
				}
				if err := saveBackupEnv(cfg); err != nil {
					return err
				}
				color.Yellow("  ⚠ %s", components.LocalOnlyWarning)
				return components.ReconfigureBackupConsumers(cfg)
			}
			b := &cfg.Backup
			for _, f := range []struct {
				v   string
				dst *string
			}{{setEndpoint, &b.Endpoint}, {setBucket, &b.Bucket}, {setRegion, &b.Region}, {setPrefix, &b.Prefix}} {
				if f.v != "" {
					*f.dst = strings.TrimSpace(f.v)
				}
			}
			if b.Bucket == "" {
				return fmt.Errorf("--bucket is required")
			}
			if err := readCredentials(cfg, cmd.InOrStdin(), credsStdin); err != nil {
				return err
			}
			t := components.BackupTargetFromConfig(cfg)
			color.Cyan("  · checking the backup target %s (write, read back, delete)...", t.Describe())
			if err := probeBackupTarget(t); err != nil {
				return err
			}
			b.Mode, b.LocalOnly = config.BackupModeExternal, false
			if err := components.ApplyBackupTarget(cfg, t); err != nil {
				return err
			}
			if err := saveBackupEnv(cfg); err != nil {
				return err
			}
			color.Green("  ✓ Backup target set: %s (credentials in Kubernetes Secrets only)", t.Describe())
			return components.ReconfigureBackupConsumers(cfg)
		}}
	set.Flags().StringVar(&setEndpoint, "endpoint", "", "S3 endpoint URL (empty = AWS S3)")
	set.Flags().StringVar(&setBucket, "bucket", "", "bucket name")
	set.Flags().StringVar(&setRegion, "region", "", "region (default us-east-1; R2 uses auto)")
	set.Flags().StringVar(&setPrefix, "prefix", "", "folder inside the bucket")
	set.Flags().BoolVar(&setLocal, "local", false, "keep backups only on this server (not recommended)")
	set.Flags().BoolVar(&credsStdin, "credentials-stdin", false, "read the access key ID and secret access key as two lines on stdin")
	show := &cobra.Command{Use: "show", Short: "Show where backups are stored (never the credentials)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			w := cmd.OutOrStdout()
			if !cfg.BackupExternal() {
				fmt.Fprintf(w, "Mode: local only\nWARNING: %s\n", components.LocalOnlyWarning)
				return nil
			}
			printTargetSettings(w, components.BackupTargetFromConfig(cfg), cfg.IsHA())
			stored, err := components.ReadBackupTarget()
			if err != nil {
				color.New(color.FgRed).Fprintf(w, "WARNING: %v\n", err)
				return nil
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
			defer cancel()
			if names, err := backup.NewS3Client(stored).ListFolders(ctx, stored.Key(backup.PrefixPostgres)); err == nil {
				fmt.Fprintf(w, "PostgreSQL archives in the target (server names): %s\n", strings.Join(names, ", "))
			}
			return nil
		}}
	test := &cobra.Command{Use: "test", Short: "Write, read back and delete a test object in the backup target", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if !cfg.BackupExternal() {
				return fmt.Errorf("no off-site backup target is configured; run: sudo platformctl backup target set")
			}
			t, err := components.ReadBackupTarget()
			if err != nil {
				return err
			}
			if err := probeBackupTarget(t); err != nil {
				return err
			}
			color.Green("  ✓ Backup target works: %s", t.Describe())
			return nil
		}}
	targetCmd.AddCommand(set, show, test)
	backupCmd.AddCommand(targetCmd)
}

// printTargetSettings prints the target's non-secret settings for `backup
// target show`. The endpoint is shown as configured, scheme included, so a
// plain-http endpoint is visible as such.
func printTargetSettings(w io.Writer, t backup.S3Target, ha bool) {
	fmt.Fprintf(w, "Mode: off-site\nEndpoint: %s\nBucket: %s\nRegion: %s\nPrefix: %s\n", t.EndpointURL(), t.Bucket, t.SigningRegion(), t.Prefix)
	fmt.Fprintf(w, "PostgreSQL archive: %s\nEncrypted archives: s3://%s/%s\n", t.PostgresDestination(), t.Bucket, t.Key(backup.PrefixArchives))
	if ha {
		fmt.Fprintf(w, "etcd snapshots: s3://%s/%s\nLonghorn backups: %s\n", t.Bucket, t.Key(backup.PrefixEtcd), t.LonghornBackupTarget())
	}
	fmt.Fprintf(w, "Credentials: Kubernetes Secret platform/%s (copies in databases/%s", backup.TargetSecret, backup.PostgresTargetSecret)
	if ha {
		fmt.Fprintf(w, ", kube-system/%s, longhorn-system/%s", backup.EtcdTargetSecret, backup.LonghornTargetSecret)
	}
	fmt.Fprintln(w, ")")
}
