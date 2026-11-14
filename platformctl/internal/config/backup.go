package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
)

// Backup storage modes (BACKUP_MODE). "" means the choice was never made
// (installs from before #186); it is reported like local-only.
const (
	BackupModeExternal = "external"
	BackupModeLocal    = "local"
)

// PostgreSQL engines (POSTGRES_ENGINE). Fresh installs use CloudNativePG on
// every profile; "bitnami" marks a single-node install that still runs the
// Bitnami release until `platformctl postgres migrate` moves it (#180).
const (
	PostgresEngineCNPG    = "cnpg"
	PostgresEngineBitnami = "bitnami"
)

// BackupSettings is the external backup target (#186). Only the non-secret
// fields are saved to /etc/platform/.env; AccessKey and SecretKey come from
// the environment (BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY) or the prompt
// and are written only to Kubernetes Secrets.
type BackupSettings struct {
	Mode                             string
	Endpoint, Bucket, Region, Prefix string
	AccessKey, SecretKey             string
	// LocalOnly is --local-backups / BACKUP_LOCAL_ONLY=true for this run.
	LocalOnly bool
	// AgeRecipient (BACKUP_AGE_RECIPIENT, public key) lets provision write
	// /etc/platform/backup.json and schedule nightly archives.
	AgeRecipient string
}

func (c *Config) loadBackup() {
	c.Backup = BackupSettings{
		Mode:         strings.ToLower(strings.TrimSpace(os.Getenv("BACKUP_MODE"))),
		Endpoint:     strings.TrimSpace(os.Getenv("BACKUP_S3_ENDPOINT")),
		Bucket:       strings.TrimSpace(os.Getenv("BACKUP_S3_BUCKET")),
		Region:       strings.TrimSpace(os.Getenv("BACKUP_S3_REGION")),
		Prefix:       strings.Trim(strings.TrimSpace(os.Getenv("BACKUP_S3_PREFIX")), "/"),
		AccessKey:    strings.TrimSpace(os.Getenv("BACKUP_S3_ACCESS_KEY")),
		SecretKey:    strings.TrimSpace(os.Getenv("BACKUP_S3_SECRET_KEY")),
		LocalOnly:    getEnvBool("BACKUP_LOCAL_ONLY", false),
		AgeRecipient: strings.TrimSpace(os.Getenv("BACKUP_AGE_RECIPIENT")),
	}
	if c.Backup.Mode != BackupModeExternal && c.Backup.Mode != BackupModeLocal {
		c.Backup.Mode = ""
	}
	c.PostgresEngine = strings.ToLower(strings.TrimSpace(os.Getenv("POSTGRES_ENGINE")))
	if c.PostgresEngine != PostgresEngineCNPG && c.PostgresEngine != PostgresEngineBitnami {
		c.PostgresEngine = ""
	}
}

// BackupExternal reports a configured external target.
func (c *Config) BackupExternal() bool {
	return c.Backup.Mode == BackupModeExternal && c.Backup.Bucket != ""
}

// HasBackupCredentials reports credentials given for this run.
func (b BackupSettings) HasCredentials() bool { return b.AccessKey != "" && b.SecretKey != "" }

// ResolveBackupChoice applies --local-backups and settings given via env/flags
// to Mode. It returns an error in non-interactive mode when a fresh install
// has neither an external target nor an explicit local-only choice.
func (c *Config) ResolveBackupChoice(freshInstall bool) error {
	b := &c.Backup
	if b.LocalOnly {
		if b.Bucket != "" && b.HasCredentials() {
			return fmt.Errorf("choose one: --local-backups or an external backup target (BACKUP_S3_*), not both")
		}
		b.Mode = BackupModeLocal
		return nil
	}
	if b.Bucket != "" {
		b.Mode = BackupModeExternal
		return nil
	}
	if b.Mode != "" {
		return nil
	}
	if c.NonInteractive && freshInstall {
		return fmt.Errorf("an external backup target is required: set BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY " +
			"(plus BACKUP_S3_ENDPOINT for R2, B2 or MinIO, and optionally BACKUP_S3_REGION, BACKUP_S3_PREFIX), " +
			"or pass --local-backups to keep backups only on this server (not recommended; see docs/operations/backups.md)")
	}
	return nil
}

// PromptBackupTarget asks where backups go. askSecretFn is replaceable in tests.
func (c *Config) PromptBackupTarget() {
	b := &c.Backup
	color.Cyan("\n  ■ Backups\n")
	color.Yellow("    Backups and the PostgreSQL recovery log should live outside this server, in S3-compatible storage")
	color.Yellow("    (AWS S3, Cloudflare R2, Backblaze B2 or a MinIO on another machine). Losing the server must not lose them.\n")
	external := b.Mode != BackupModeLocal
	askBool("Store backups in S3-compatible storage outside this server (recommended)", &external)
	if !external {
		color.Yellow("    Backups will be stored only on this server. Cairn shows a warning until you add a target:")
		color.Yellow("      sudo platformctl backup target set")
		b.Mode, b.LocalOnly = BackupModeLocal, true
		return
	}
	b.Mode, b.LocalOnly = BackupModeExternal, false
	askAlways("Endpoint URL (Enter for AWS S3; for example https://<account>.r2.cloudflarestorage.com)", &b.Endpoint, b.Endpoint)
	askAlways("Bucket", &b.Bucket, b.Bucket)
	askAlways("Region (Enter for us-east-1; R2 uses auto)", &b.Region, b.Region)
	askAlways("Folder inside the bucket (optional, for example cairn/server-a)", &b.Prefix, b.Prefix)
	b.Prefix = strings.Trim(b.Prefix, "/")
	b.AccessKey, b.SecretKey = "", ""
	askSecretFn("Access key ID", &b.AccessKey)
	askSecretFn("Secret access key", &b.SecretKey)
}

var askSecretFn = askSecret

func (c *Config) backupEnv() (string, error) {
	b := c.Backup
	for _, v := range []string{b.Mode, b.Endpoint, b.Bucket, b.Region, b.Prefix, c.PostgresEngine} {
		if strings.ContainsAny(v, "\r\n") {
			return "", fmt.Errorf("backup settings cannot contain line breaks")
		}
	}
	var s strings.Builder
	if c.PostgresEngine != "" {
		fmt.Fprintf(&s, "POSTGRES_ENGINE=%s\n", c.PostgresEngine)
	}
	if b.Mode == "" {
		return s.String(), nil
	}
	// Never the access key or secret: those are in Kubernetes Secrets only.
	fmt.Fprintf(&s, "BACKUP_MODE=%s\n", b.Mode)
	if b.Mode == BackupModeExternal {
		fmt.Fprintf(&s, "BACKUP_S3_ENDPOINT=%s\nBACKUP_S3_BUCKET=%s\nBACKUP_S3_REGION=%s\nBACKUP_S3_PREFIX=%s\n", b.Endpoint, b.Bucket, b.Region, b.Prefix)
	}
	return s.String(), nil
}
