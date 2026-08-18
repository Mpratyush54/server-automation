package components

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestPersistLocalCredentialsWritesEnvAndFiles(t *testing.T) {
	root := t.TempDir()
	envFile := filepath.Join(root, ".env")
	credDir := filepath.Join(root, "credentials")
	if err := os.WriteFile(envFile, []byte("GITHUB_TOKEN=keep\nPOSTGRES_PASSWORD=old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	err := PersistLocalCredentials(envFile, credDir, map[string]string{
		"POSTGRES_PASSWORD":      "new-pg",
		"POSTGRES_PASSWORD_PREV": "old",
		"ADMIN_PASSWORD":         "admin-secret",
		"REDIS_PASSWORD":         "redis-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	env, _ := os.ReadFile(envFile)
	if !strings.Contains(string(env), "GITHUB_TOKEN=keep") {
		t.Fatal("must keep unrelated .env keys")
	}
	if !strings.Contains(string(env), "POSTGRES_PASSWORD=new-pg") {
		t.Fatal("must upsert postgres password into .env")
	}
	pg, _ := os.ReadFile(filepath.Join(credDir, "postgres"))
	if strings.TrimSpace(string(pg)) != "new-pg" {
		t.Fatalf("postgres file = %q", pg)
	}
	prev, _ := os.ReadFile(filepath.Join(credDir, "postgres.prev"))
	if strings.TrimSpace(string(prev)) != "old" {
		t.Fatalf("postgres.prev = %q", prev)
	}
	admin, _ := os.ReadFile(filepath.Join(credDir, "admin"))
	if strings.TrimSpace(string(admin)) != "admin-secret" {
		t.Fatalf("admin file = %q", admin)
	}
}

func TestWriteFileSyncCreatesParent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "pw")
	if err := config.WriteFileSync(path, "secret\n", 0600); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "secret\n" {
		t.Fatalf("got %q", data)
	}
}

func TestBackupLocalStateCopiesEnv(t *testing.T) {
	root := t.TempDir()
	envFile := filepath.Join(root, ".env")
	if err := os.WriteFile(envFile, []byte("POSTGRES_PASSWORD=saved\n"), 0600); err != nil {
		t.Fatal(err)
	}
	dir, err := BackupLocalState(filepath.Join(root, "backups"), envFile)
	if err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(filepath.Join(dir, "env"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(copied), "POSTGRES_PASSWORD=saved") {
		t.Fatalf("backup missing env: %s", copied)
	}
}
