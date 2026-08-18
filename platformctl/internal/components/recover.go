package components

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
	"golang.org/x/crypto/bcrypt"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

func sqlLiteral(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

func firstFilled(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func kubeSecretValue(ns, name, key string) string {
	script := fmt.Sprintf(`
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n %s get secret %s -o jsonpath="{.data['%s']}" 2>/dev/null | base64 -d 2>/dev/null || true
`, ns, name, key)
	out, err := shell.OutputBash(script)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

func randomToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	s := base64.RawURLEncoding.EncodeToString(b)
	if len(s) < n {
		return s
	}
	return s[:n]
}

const recoverScript = `
set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

b64() { printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64; }

SQL_FILE="${PLATFORM_RECOVER_SQL}"
ALTER_FILE="${PLATFORM_RECOVER_ALTER}"
PG_PASS="${PLATFORM_RECOVER_PG_PASS}"
RD_PASS="${PLATFORM_RECOVER_RD_PASS:-}"
RD_OLD="${PLATFORM_RECOVER_RD_OLD:-}"

PG_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$PG_POD" ]]; then PG_POD=postgresql-0; fi
echo "  · using Postgres pod $PG_POD"

if ! kubectl -n databases exec -i "$PG_POD" -- bash -lc 'psql -U postgres -d platform -v ON_ERROR_STOP=1' < "$SQL_FILE"; then
  echo "  · retrying ALTER USER against database postgres"
  kubectl -n databases exec -i "$PG_POD" -- bash -lc 'psql -U postgres -d postgres -v ON_ERROR_STOP=1' < "$ALTER_FILE"
fi

PG_B64="$(b64 "$PG_PASS")"
kubectl -n platform patch secret platform-env --type merge -p "{\"data\":{\"POSTGRES_PASSWORD\":\"$PG_B64\"}}"
kubectl -n databases patch secret postgresql --type merge -p "{\"data\":{\"postgres-password\":\"$PG_B64\",\"password\":\"$PG_B64\"}}" || true

if [[ -n "$RD_PASS" ]]; then
  RD_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=redis -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "$RD_POD" ]]; then RD_POD=redis-master-0; fi
  echo "  · using Redis pod $RD_POD"
  kubectl -n databases exec "$RD_POD" -- redis-cli CONFIG SET requirepass "$RD_PASS" >/dev/null 2>&1 \
    || kubectl -n databases exec "$RD_POD" -- redis-cli -a "$RD_OLD" CONFIG SET requirepass "$RD_PASS" >/dev/null 2>&1 \
    || kubectl -n databases exec "$RD_POD" -- redis-cli -a "$RD_PASS" CONFIG SET requirepass "$RD_PASS" >/dev/null 2>&1 \
    || echo "  · Redis CONFIG SET skipped (pod not ready)"
  RD_B64="$(b64 "$RD_PASS")"
  kubectl -n platform patch secret platform-env --type merge -p "{\"data\":{\"REDIS_PASSWORD\":\"$RD_B64\"}}" || true
  kubectl -n databases patch secret redis --type merge -p "{\"data\":{\"redis-password\":\"$RD_B64\"}}" || true
fi

kubectl -n platform delete secret platform-rotate-pending --ignore-not-found >/dev/null 2>&1 || true
kubectl -n platform rollout restart deployment/platform-api
kubectl -n platform rollout status deployment/platform-api --timeout=180s || true
`

// RecoverAccess restores Postgres/Redis credentials and admin login from the
// k3s host when the API cannot authenticate after a partial secret rotate.
// It uses local access inside the database pods (no API token required).
func RecoverAccess(cfg *config.Config) error {
	color.Cyan("\n  ■ Recovering platform access\n")
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")

	pgPass := firstFilled(
		cfg.PostgresPassword,
		kubeSecretValue("platform", "platform-env", "POSTGRES_PASSWORD"),
		kubeSecretValue("databases", "postgresql", "postgres-password"),
		kubeSecretValue("databases", "postgresql", "password"),
		kubeSecretValue("platform", "platform-rotate-pending", "POSTGRES_PASSWORD_OLD"),
		kubeSecretValue("platform", "platform-rotate-pending", "POSTGRES_PASSWORD_NEW"),
	)
	if pgPass == "" {
		pgPass = randomToken(24)
		color.Yellow("  · no stored Postgres password found — generated a new one")
	}
	cfg.PostgresPassword = pgPass

	rdPass := firstFilled(
		cfg.RedisPassword,
		kubeSecretValue("platform", "platform-env", "REDIS_PASSWORD"),
		kubeSecretValue("databases", "redis", "redis-password"),
		kubeSecretValue("platform", "platform-rotate-pending", "REDIS_PASSWORD_OLD"),
		kubeSecretValue("platform", "platform-rotate-pending", "REDIS_PASSWORD_NEW"),
	)
	cfg.RedisPassword = rdPass

	adminPass := cfg.AdminPassword
	if strings.TrimSpace(adminPass) == "" {
		adminPass = randomToken(16)
		cfg.AdminPassword = adminPass
		color.Yellow("  · ADMIN_PASSWORD was empty — generated a new admin password")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(adminPass), 10)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}

	sqlPath := "/tmp/platformctl-recover.sql"
	alterPath := "/tmp/platformctl-recover-alter.sql"
	alterSQL := fmt.Sprintf("ALTER USER postgres WITH PASSWORD '%s';\n", sqlLiteral(pgPass))
	fullSQL := alterSQL + fmt.Sprintf(
		"UPDATE users SET password_hash = '%s', is_active = true WHERE role = 'admin';\n",
		sqlLiteral(string(hash)),
	)
	if err := os.WriteFile(sqlPath, []byte(fullSQL), 0600); err != nil {
		return fmt.Errorf("write recover SQL: %w", err)
	}
	if err := os.WriteFile(alterPath, []byte(alterSQL), 0600); err != nil {
		return fmt.Errorf("write recover ALTER SQL: %w", err)
	}
	defer os.Remove(sqlPath)
	defer os.Remove(alterPath)

	_ = os.Setenv("PLATFORM_RECOVER_SQL", sqlPath)
	_ = os.Setenv("PLATFORM_RECOVER_ALTER", alterPath)
	_ = os.Setenv("PLATFORM_RECOVER_PG_PASS", pgPass)
	_ = os.Setenv("PLATFORM_RECOVER_RD_PASS", rdPass)
	_ = os.Setenv("PLATFORM_RECOVER_RD_OLD", firstFilled(
		kubeSecretValue("platform", "platform-rotate-pending", "REDIS_PASSWORD_OLD"),
		kubeSecretValue("databases", "redis", "redis-password"),
		kubeSecretValue("platform", "platform-env", "REDIS_PASSWORD"),
	))

	if err := shell.RunBash(recoverScript); err != nil {
		return fmt.Errorf("recover failed: %w", err)
	}

	if err := config.UpsertEnvKey("/etc/platform/.env", "POSTGRES_PASSWORD", pgPass); err != nil {
		color.Yellow("  ⚠ could not update POSTGRES_PASSWORD in /etc/platform/.env: %v", err)
	}
	if rdPass != "" {
		if err := config.UpsertEnvKey("/etc/platform/.env", "REDIS_PASSWORD", rdPass); err != nil {
			color.Yellow("  ⚠ could not update REDIS_PASSWORD in /etc/platform/.env: %v", err)
		}
	}
	if err := config.UpsertEnvKey("/etc/platform/.env", "ADMIN_PASSWORD", adminPass); err != nil {
		color.Yellow("  ⚠ could not update ADMIN_PASSWORD in /etc/platform/.env: %v", err)
	}

	email := cfg.AdminEmail
	if email == "" {
		email = "admin@pratyushes.dev"
	}
	color.Green("  ✓ Access restored")
	color.Cyan("\n  Login (from /etc/platform/.env):")
	fmt.Printf("    Portal:   https://%s\n", cfg.Domain)
	fmt.Printf("    Email:    %s\n", email)
	fmt.Printf("    Password: %s\n", adminPass)
	color.Cyan("\n  Next: pull the new images with:")
	fmt.Printf("    sudo platformctl update\n")
	return nil
}
