package cmd

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func backupSandbox(t *testing.T) *[]backup.S3Target {
	t.Helper()
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	var probed []backup.S3Target
	oldProbe, oldPrompt := probeBackupTarget, promptBackup
	probeBackupTarget = func(tg backup.S3Target) error { probed = append(probed, tg); return nil }
	promptBackup = func(*config.Config) { t.Fatal("unexpected prompt") }
	oldFlags := []any{localBackupsFlag, backupEndpointFlag, backupBucketFlag, backupRegionFlag, backupPrefixFlag, backupRecipientFlag}
	t.Cleanup(func() {
		state.SetPath(state.DefaultPath)
		probeBackupTarget, promptBackup = oldProbe, oldPrompt
		localBackupsFlag = oldFlags[0].(bool)
		backupEndpointFlag, backupBucketFlag, backupRegionFlag, backupPrefixFlag, backupRecipientFlag = oldFlags[1].(string), oldFlags[2].(string), oldFlags[3].(string), oldFlags[4].(string), oldFlags[5].(string)
	})
	return &probed
}

func TestResolveBackupTargetAuto(t *testing.T) {
	probed := backupSandbox(t)
	// Fresh --auto install without a target or --local-backups stops early.
	c := &config.Config{NonInteractive: true}
	if err := resolveBackupTarget(c); err == nil || !strings.Contains(err.Error(), "--local-backups") {
		t.Fatal(err)
	}
	// Flags plus env credentials: validated and probed.
	backupBucketFlag, backupEndpointFlag, backupPrefixFlag = "cairn-bk", "https://s3.example.net", "srv-a"
	c = &config.Config{NonInteractive: true, Backup: config.BackupSettings{AccessKey: "AK", SecretKey: "SK"}}
	if err := resolveBackupTarget(c); err != nil {
		t.Fatal(err)
	}
	if c.Backup.Mode != config.BackupModeExternal || len(*probed) != 1 || (*probed)[0].Describe() != "s3.example.net/cairn-bk/srv-a" {
		t.Fatal(c.Backup, *probed)
	}
	// A failing probe fails provisioning with its plain message.
	probeBackupTarget = func(backup.S3Target) error {
		return errors.New(`cannot write to the backup target: bucket "cairn-bk" does not exist`)
	}
	c = &config.Config{NonInteractive: true, Backup: config.BackupSettings{AccessKey: "AK", SecretKey: "SK"}}
	if err := resolveBackupTarget(c); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatal(err)
	}
	// Bucket without credentials on a fresh install.
	c = &config.Config{NonInteractive: true}
	if err := resolveBackupTarget(c); err == nil || !strings.Contains(err.Error(), "BACKUP_S3_SECRET_KEY") {
		t.Fatal(err)
	}
	// Re-provision of an existing install reuses the stored credentials.
	if err := state.MarkDone("postgresql"); err != nil {
		t.Fatal(err)
	}
	c = &config.Config{NonInteractive: true, Backup: config.BackupSettings{Mode: config.BackupModeExternal}}
	if err := resolveBackupTarget(c); err != nil {
		t.Fatal(err)
	}
}

func TestResolveBackupTargetLocalAndInteractive(t *testing.T) {
	probed := backupSandbox(t)
	localBackupsFlag = true
	c := &config.Config{NonInteractive: true}
	if err := resolveBackupTarget(c); err != nil || c.Backup.Mode != config.BackupModeLocal || len(*probed) != 0 {
		t.Fatal(err, c.Backup.Mode)
	}
	localBackupsFlag = false
	// Interactive: asked once; a failed probe asks again.
	asks := 0
	promptBackup = func(c *config.Config) {
		asks++
		c.Backup = config.BackupSettings{Mode: config.BackupModeExternal, Bucket: "bucket-" + string(rune('a'+asks)), AccessKey: "AK", SecretKey: "SK"}
	}
	calls := 0
	probeBackupTarget = func(backup.S3Target) error {
		calls++
		if calls == 1 {
			return errors.New("access denied")
		}
		return nil
	}
	c = &config.Config{}
	if err := resolveBackupTarget(c); err != nil || asks != 2 || c.Backup.Bucket != "bucket-c" {
		t.Fatal(err, asks, c.Backup)
	}
}

func TestGraphRunsArchivingOnFreshSingleNodeInstalls(t *testing.T) {
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	defer state.SetPath(state.DefaultPath)
	for _, profile := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull, config.ProfileHA} {
		c := allOn()
		c.Profile = profile
		for _, s := range provisionGraph(c) {
			if (s.name == "postgresql-backup" || s.name == "postgresql-monitoring") && s.skip {
				t.Fatalf("%s skipped on fresh %s", s.name, profile)
			}
		}
	}
	// Not yet migrated (Bitnami): skipped.
	c := allOn()
	c.Profile, c.PostgresEngine = config.ProfileStandard, config.PostgresEngineBitnami
	for _, s := range provisionGraph(c) {
		if s.name == "postgresql-backup" && !s.skip {
			t.Fatal("Bitnami installs have no WAL archiving")
		}
	}
}

func TestChildStepsDoNotInheritTargetCredentials(t *testing.T) {
	env := childEnviron([]string{"PATH=/bin", "BACKUP_S3_ACCESS_KEY=AK", "BACKUP_S3_SECRET_KEY=SK", "BACKUP_S3_BUCKET=b"}, map[string]bool{})
	if strings.Join(env, " ") != "PATH=/bin BACKUP_S3_BUCKET=b" {
		t.Fatal(env)
	}
}

func TestPITROptions(t *testing.T) {
	o, err := pitrOptions("latest", "postgresql-old")
	if err != nil || !o.Latest || o.SourceServer != "postgresql-old" {
		t.Fatal(o, err)
	}
	o, err = pitrOptions("2026-11-12T10:00:00Z", "")
	if err != nil || !o.Target.Equal(time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)) {
		t.Fatal(o, err)
	}
	if _, err := pitrOptions("yesterday", ""); err == nil || !strings.Contains(err.Error(), "or latest") {
		t.Fatal(err)
	}
}

func TestExternalArchiveTargetKeyword(t *testing.T) {
	c := backup.Config{Target: backup.ExternalTargetKeyword, Recipient: "age1x", Retention: backup.Retention{Daily: 1}, Components: []string{"config", "postgres"}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := defaultArchiveTarget(&config.Config{Backup: config.BackupSettings{Mode: config.BackupModeExternal, Bucket: "b-1"}}); got != "external" {
		t.Fatal(got)
	}
	if got := defaultArchiveTarget(&config.Config{}); got != defaultLocalArchiveTarget {
		t.Fatal(got)
	}
	if got, err := resolveArchiveTarget("file:///x"); err != nil || got != "file:///x" {
		t.Fatal(got, err)
	}
}

func TestPrintTargetSettingsKeepsEndpointScheme(t *testing.T) {
	var b strings.Builder
	tg := backup.S3Target{Endpoint: "http://10.0.0.5:9000", Bucket: "offsite", AccessKey: "AK" + "notreal", SecretKey: "SK" + "notreal"}.Normalize()
	printTargetSettings(&b, tg, true)
	out := b.String()
	if !strings.Contains(out, "Endpoint: http://10.0.0.5:9000\n") || strings.Contains(out, "notreal") || !strings.Contains(out, "etcd snapshots:") {
		t.Fatalf("show output:\n%s", out)
	}
	b.Reset()
	printTargetSettings(&b, backup.S3Target{Bucket: "offsite", Region: "eu-west-1"}, false)
	if !strings.Contains(b.String(), "Endpoint: https://s3.eu-west-1.amazonaws.com\n") || strings.Contains(b.String(), "etcd") {
		t.Fatalf("AWS default:\n%s", b.String())
	}
}
