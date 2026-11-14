package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadBackupSettingsKeepsCredentialsOutOfEnvFile(t *testing.T) {
	oldPath := envFilePath
	envFilePath = filepath.Join(t.TempDir(), "absent.env")
	defer func() { envFilePath = oldPath }()
	for k, v := range map[string]string{
		"BACKUP_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com", "BACKUP_S3_BUCKET": "cairn-bk", "BACKUP_S3_REGION": "auto",
		"BACKUP_S3_PREFIX": "/srv-a/", "BACKUP_S3_ACCESS_KEY": "AKVALUE", "BACKUP_S3_SECRET_KEY": "SKVALUE", "POSTGRES_ENGINE": "CNPG",
	} {
		t.Setenv(k, v)
	}
	c := Load()
	if c.Backup.Prefix != "srv-a" || !c.Backup.HasCredentials() || c.PostgresEngine != PostgresEngineCNPG {
		t.Fatal(c.Backup, c.PostgresEngine)
	}
	if err := c.ResolveBackupChoice(true); err != nil || !c.BackupExternal() {
		t.Fatal(err, c.Backup.Mode)
	}
	path := filepath.Join(t.TempDir(), ".env")
	if err := c.SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	s := string(b)
	for _, want := range []string{"BACKUP_MODE=external\n", "BACKUP_S3_BUCKET=cairn-bk\n", "BACKUP_S3_ENDPOINT=https://acct.r2.cloudflarestorage.com\n", "BACKUP_S3_PREFIX=srv-a\n", "POSTGRES_ENGINE=cnpg\n"} {
		if !strings.Contains(s, want) {
			t.Fatal(s)
		}
	}
	if strings.Contains(s, "AKVALUE") || strings.Contains(s, "SKVALUE") || strings.Contains(s, "BACKUP_S3_ACCESS_KEY") || strings.Contains(s, "BACKUP_S3_SECRET_KEY") {
		t.Fatal("credentials written to .env")
	}
}

func TestResolveBackupChoice(t *testing.T) {
	for _, tc := range []struct {
		name  string
		c     Config
		fresh bool
		mode  string
		err   string
	}{
		{"auto fresh without target fails", Config{NonInteractive: true}, true, "", "external backup target is required"},
		{"auto existing install keeps going", Config{NonInteractive: true}, false, "", ""},
		{"explicit local", Config{NonInteractive: true, Backup: BackupSettings{LocalOnly: true}}, true, BackupModeLocal, ""},
		{"local and target conflict", Config{Backup: BackupSettings{LocalOnly: true, Bucket: "bk-1", AccessKey: "a", SecretKey: "b"}}, true, "", "choose one"},
		{"bucket given", Config{NonInteractive: true, Backup: BackupSettings{Bucket: "bk-1"}}, true, BackupModeExternal, ""},
		{"recorded local", Config{NonInteractive: true, Backup: BackupSettings{Mode: BackupModeLocal}}, true, BackupModeLocal, ""},
		{"interactive undecided", Config{}, true, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.c.ResolveBackupChoice(tc.fresh)
			if tc.err != "" {
				if err == nil || !strings.Contains(err.Error(), tc.err) {
					t.Fatal(err)
				}
				return
			}
			if err != nil || tc.c.Backup.Mode != tc.mode {
				t.Fatal(err, tc.c.Backup.Mode)
			}
		})
	}
	// The --auto error names every setting and the opt-out.
	err := (&Config{NonInteractive: true}).ResolveBackupChoice(true)
	for _, want := range []string{"BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY", "BACKUP_S3_ENDPOINT", "--local-backups"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatal(err)
		}
	}
}

func TestBackupEnvOmittedUntilChosen(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := (&Config{}).SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if strings.Contains(string(b), "BACKUP_MODE") || strings.Contains(string(b), "BACKUP_S3_") || strings.Contains(string(b), "POSTGRES_ENGINE") {
		t.Fatal(string(b))
	}
	local := &Config{Backup: BackupSettings{Mode: BackupModeLocal, Bucket: "ignored"}}
	if err := local.SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	if !strings.Contains(string(b), "BACKUP_MODE=local\n") || strings.Contains(string(b), "BACKUP_S3_BUCKET") {
		t.Fatal(string(b))
	}
	if err := (&Config{Backup: BackupSettings{Mode: BackupModeExternal, Bucket: "a\nb"}}).SaveEnvFile(path); err == nil {
		t.Fatal("line breaks accepted")
	}
}

func TestPromptBackupTargetLocalChoice(t *testing.T) {
	// askBool reads stdin; an empty stdin keeps the default (external), so
	// only the secret prompts are replaced here.
	old := askSecretFn
	defer func() { askSecretFn = old }()
	askSecretFn = func(_ string, dst *string) { *dst = "typed" }
	r, w, _ := os.Pipe()
	w.WriteString("n\n")
	w.Close()
	oldStdin := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = oldStdin }()
	c := &Config{}
	c.PromptBackupTarget()
	if c.Backup.Mode != BackupModeLocal || !c.Backup.LocalOnly {
		t.Fatal(c.Backup)
	}
}
