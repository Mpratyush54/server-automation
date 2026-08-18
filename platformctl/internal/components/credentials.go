package components

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

const (
	defaultEnvFile    = "/etc/platform/.env"
	defaultCredDir    = "/etc/platform/credentials"
	defaultBackupRoot = "/var/lib/platform/backups"
)

func persistCredentialFile(dir, name, value string) error {
	if value == "" {
		return nil
	}
	return config.WriteFileSync(filepath.Join(dir, name), value+"\n", 0600)
}

// PersistLocalCredentials writes live passwords to /etc/platform/.env and
// individual 0600 files under credentials/. Call this before any ALTER USER.
func PersistLocalCredentials(envFile, credDir string, values map[string]string) error {
	if envFile == "" {
		envFile = defaultEnvFile
	}
	if credDir == "" {
		credDir = defaultCredDir
	}
	if err := os.MkdirAll(credDir, 0700); err != nil {
		return err
	}
	keyFiles := map[string]string{
		"POSTGRES_PASSWORD": "postgres",
		"REDIS_PASSWORD":    "redis",
		"ADMIN_PASSWORD":    "admin",
	}
	for envKey, file := range keyFiles {
		if v := values[envKey]; v != "" {
			if err := persistCredentialFile(credDir, file, v); err != nil {
				return fmt.Errorf("write %s: %w", file, err)
			}
			if err := config.UpsertEnvKey(envFile, envKey, v); err != nil {
				return fmt.Errorf("upsert %s: %w", envKey, err)
			}
		}
	}
	if v := values["POSTGRES_PASSWORD_PREV"]; v != "" {
		if err := persistCredentialFile(credDir, "postgres.prev", v); err != nil {
			return err
		}
	}
	if v := values["POSTGRES_PASSWORD_NEXT"]; v != "" {
		if err := persistCredentialFile(credDir, "postgres.next", v); err != nil {
			return err
		}
	}
	return nil
}

// BackupLocalState copies .env and cluster secrets to a timestamped host directory
// before recover/rotate mutates anything.
func BackupLocalState(backupRoot, envFile string) (string, error) {
	if backupRoot == "" {
		backupRoot = defaultBackupRoot
	}
	if envFile == "" {
		envFile = defaultEnvFile
	}
	dir := filepath.Join(backupRoot, time.Now().UTC().Format("20060102T150405Z"))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	if data, err := os.ReadFile(envFile); err == nil {
		if err := config.WriteFileSync(filepath.Join(dir, "env"), string(data), 0600); err != nil {
			return "", err
		}
	}
	readme := "Platform credential backup. Restore .env from env; Kubernetes secrets are YAML dumps.\nCreated by platformctl backup/recover.\n"
	if err := config.WriteFileSync(filepath.Join(dir, "README"), readme, 0600); err != nil {
		return "", err
	}
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
	_ = shell.RunBash(fmt.Sprintf(`
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
mkdir -p %s
kubectl -n platform get secret platform-env -o yaml > %s/platform-env.secret.yaml 2>/dev/null || true
kubectl -n databases get secret postgresql -o yaml > %s/postgresql.secret.yaml 2>/dev/null || true
kubectl -n databases get secret redis -o yaml > %s/redis.secret.yaml 2>/dev/null || true
kubectl -n platform get secret platform-rotate-pending -o yaml > %s/rotate-pending.secret.yaml 2>/dev/null || true
`, dir, dir, dir, dir, dir))
	return dir, nil
}
