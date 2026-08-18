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

func uniqueFilled(vals ...string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if v == "" || seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
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
set -uo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

b64() { printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64; }

SQL_FILE="${PLATFORM_RECOVER_SQL}"
ALTER_FILE="${PLATFORM_RECOVER_ALTER}"
CAND_FILE="${PLATFORM_RECOVER_PG_CANDIDATES}"
PG_TARGET="${PLATFORM_RECOVER_PG_PASS}"
RD_PASS="${PLATFORM_RECOVER_RD_PASS:-}"
RD_OLD="${PLATFORM_RECOVER_RD_OLD:-}"
CRED_DIR="${PLATFORM_CRED_DIR:-/etc/platform/credentials}"
ENV_FILE="${PLATFORM_ENV_FILE:-/etc/platform/.env}"
WORKING_OUT="${PLATFORM_RECOVER_WORKING_OUT}"

mkdir -p "$CRED_DIR"
chmod 700 "$CRED_DIR" 2>/dev/null || true

persist_pg_now() {
  local pw="$1"
  umask 077
  printf '%s\n' "$pw" > "$CRED_DIR/postgres.tmp"
  mv "$CRED_DIR/postgres.tmp" "$CRED_DIR/postgres"
  chmod 600 "$CRED_DIR/postgres"
  sync "$CRED_DIR/postgres" "$CRED_DIR" 2>/dev/null || sync
  printf '%s' "$pw" > "$WORKING_OUT"
}

PG_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$PG_POD" ]]; then PG_POD=postgresql-0; fi
echo "  · using Postgres pod $PG_POD"

kubectl -n databases exec "$PG_POD" -- bash -lc '
  for v in "$POSTGRESQL_PASSWORD" "$POSTGRES_PASSWORD" "$POSTGRES_POSTGRES_PASSWORD"; do
    [ -n "$v" ] && printf "%s\n" "$v"
  done
  for f in /opt/bitnami/postgresql/secrets/postgres-password \
           /opt/bitnami/postgresql/secrets/password \
           /bitnami/postgresql/secrets/postgres-password; do
    [ -f "$f" ] && cat "$f" && printf "\n"
  done
' 2>/dev/null >> "$CAND_FILE" || true

psql_with_pw() {
  local pw="$1"
  local db="$2"
  shift 2
  local pw_b64 extra
  pw_b64="$(b64 "$pw")"
  extra=$(printf '%q ' "$@")
  kubectl -n databases exec "$PG_POD" -- bash -lc \
    "export PGPASSWORD=\$(printf '%s' '$pw_b64' | base64 -d 2>/dev/null || printf '%s' '$pw_b64' | base64 -D); exec psql -w -U postgres -d $(printf '%q' "$db") -v ON_ERROR_STOP=1 $extra"
}

WORKING=""
while IFS= read -r cand || [[ -n "${cand:-}" ]]; do
  [[ -z "${cand:-}" ]] && continue
  if psql_with_pw "$cand" postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    WORKING="$cand"
    echo "  · authenticated to Postgres with a stored password"
    persist_pg_now "$WORKING"
    break
  fi
done < "$CAND_FILE"

enable_trust() {
  kubectl -n databases exec "$PG_POD" -- bash -lc '
    HBA="$(find /opt/bitnami /bitnami -name pg_hba.conf 2>/dev/null | head -1)"
    [ -n "$HBA" ] || exit 1
    cp "$HBA" /tmp/pg_hba.recover.bak
    { echo "local all all trust"; echo "host all all 127.0.0.1/32 trust"; echo "host all all ::1/128 trust"; cat /tmp/pg_hba.recover.bak; } > "$HBA"
    PGDATA="${POSTGRESQL_DATA_DIR:-${PGDATA:-/bitnami/postgresql/data}}"
    pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || /opt/bitnami/postgresql/bin/pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || kill -HUP 1 >/dev/null 2>&1 || true
  '
}

restore_trust() {
  kubectl -n databases exec "$PG_POD" -- bash -lc '
    [ -f /tmp/pg_hba.recover.bak ] || exit 0
    HBA="$(find /opt/bitnami /bitnami -name pg_hba.conf 2>/dev/null | head -1)"
    [ -n "$HBA" ] && cp /tmp/pg_hba.recover.bak "$HBA"
    PGDATA="${POSTGRESQL_DATA_DIR:-${PGDATA:-/bitnami/postgresql/data}}"
    pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || /opt/bitnami/postgresql/bin/pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || kill -HUP 1 >/dev/null 2>&1 || true
  ' 2>/dev/null || true
}

USED_TRUST=0
if [[ -z "$WORKING" ]]; then
  echo "  · no stored password worked — will ALTER only after passwords are on disk"
  persist_pg_now "$PG_TARGET"
  enable_trust || { echo "  ✗ could not enable local trust (pg_hba.conf not found)" >&2; exit 2; }
  USED_TRUST=1
  sleep 2
  if ! kubectl -n databases exec "$PG_POD" -- psql -w -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    restore_trust
    echo "  ✗ could not authenticate to Postgres" >&2
    exit 2
  fi
  echo "  · authenticated via local trust; setting role password to the on-disk value"
  kubectl -n databases exec -i "$PG_POD" -- bash -lc 'cat > /tmp/platformctl-recover-alter.sql' < "$ALTER_FILE"
  kubectl -n databases exec "$PG_POD" -- psql -w -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/platformctl-recover-alter.sql
  restore_trust
  if ! psql_with_pw "$PG_TARGET" postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "  ✗ ALTER USER ran but on-disk password still does not authenticate — leaving backup in place" >&2
    exit 2
  fi
  WORKING="$PG_TARGET"
fi

# Never ALTER when we already had a working password — sync Kubernetes to it.
PG_B64="$(b64 "$WORKING")"
kubectl -n platform patch secret platform-env --type merge -p "{\"data\":{\"POSTGRES_PASSWORD\":\"$PG_B64\"}}"
kubectl -n databases patch secret postgresql --type merge -p "{\"data\":{\"postgres-password\":\"$PG_B64\",\"password\":\"$PG_B64\"}}" || true

kubectl -n databases exec -i "$PG_POD" -- bash -lc 'cat > /tmp/platformctl-recover-admin.sql' < "$SQL_FILE"
if [[ "$USED_TRUST" = "1" ]]; then
  kubectl -n databases exec "$PG_POD" -- psql -w -U postgres -d platform -v ON_ERROR_STOP=1 -f /tmp/platformctl-recover-admin.sql >/dev/null 2>&1 || true
else
  psql_with_pw "$WORKING" platform -f /tmp/platformctl-recover-admin.sql >/dev/null 2>&1 || true
fi

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
// k3s host. It backs up and writes passwords to /etc/platform before any ALTER.
func RecoverAccess(cfg *config.Config) error {
	color.Cyan("\n  ■ Recovering platform access\n")
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")

	backupDir, err := BackupLocalState(defaultBackupRoot, defaultEnvFile)
	if err != nil {
		return fmt.Errorf("refusing to continue without a local backup: %w", err)
	}
	color.Green("  ✓ backup written to %s", backupDir)

	candidates := uniqueFilled(
		cfg.PostgresPassword,
		kubeSecretValue("platform", "platform-env", "POSTGRES_PASSWORD"),
		kubeSecretValue("databases", "postgresql", "postgres-password"),
		kubeSecretValue("databases", "postgresql", "password"),
		kubeSecretValue("platform", "platform-rotate-pending", "POSTGRES_PASSWORD_OLD"),
		kubeSecretValue("platform", "platform-rotate-pending", "POSTGRES_PASSWORD_NEW"),
	)

	pgPass := strings.TrimSpace(cfg.PostgresPassword)
	if pgPass == "" {
		pgPass = firstFilled(candidates...)
	}
	generated := false
	if pgPass == "" {
		pgPass = randomToken(24)
		generated = true
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
		generated = true
	}

	// Disk first. Never ALTER until these writes succeed.
	if err := PersistLocalCredentials(defaultEnvFile, defaultCredDir, map[string]string{
		"POSTGRES_PASSWORD":      pgPass,
		"POSTGRES_PASSWORD_PREV": firstFilled(candidates...),
		"REDIS_PASSWORD":         rdPass,
		"ADMIN_PASSWORD":         adminPass,
	}); err != nil {
		return fmt.Errorf("refusing to change database passwords; could not write /etc/platform: %w", err)
	}
	color.Green("  ✓ passwords stored at %s and %s", defaultEnvFile, defaultCredDir)
	if generated {
		color.Yellow("  · generated missing local passwords and saved them before touching Postgres")
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(adminPass), 10)
	if err != nil {
		return fmt.Errorf("hash admin password: %w", err)
	}

	sqlPath := "/tmp/platformctl-recover.sql"
	alterPath := "/tmp/platformctl-recover-alter.sql"
	candPath := "/tmp/platformctl-recover-pg-candidates"
	workingOut := "/tmp/platformctl-recover-working"
	alterSQL := fmt.Sprintf("ALTER USER postgres WITH PASSWORD '%s';\n", sqlLiteral(pgPass))
	adminSQL := fmt.Sprintf(
		"UPDATE users SET password_hash = '%s', is_active = true WHERE role = 'admin';\n",
		sqlLiteral(string(hash)),
	)
	if err := os.WriteFile(sqlPath, []byte(adminSQL), 0600); err != nil {
		return fmt.Errorf("write recover SQL: %w", err)
	}
	if err := os.WriteFile(alterPath, []byte(alterSQL), 0600); err != nil {
		return fmt.Errorf("write recover ALTER SQL: %w", err)
	}
	if err := os.WriteFile(candPath, []byte(strings.Join(candidates, "\n")+"\n"), 0600); err != nil {
		return fmt.Errorf("write postgres candidates: %w", err)
	}
	_ = os.Remove(workingOut)
	defer os.Remove(sqlPath)
	defer os.Remove(alterPath)
	defer os.Remove(candPath)
	defer os.Remove(workingOut)

	_ = os.Setenv("PLATFORM_RECOVER_SQL", sqlPath)
	_ = os.Setenv("PLATFORM_RECOVER_ALTER", alterPath)
	_ = os.Setenv("PLATFORM_RECOVER_PG_CANDIDATES", candPath)
	_ = os.Setenv("PLATFORM_RECOVER_PG_PASS", pgPass)
	_ = os.Setenv("PLATFORM_RECOVER_RD_PASS", rdPass)
	_ = os.Setenv("PLATFORM_CRED_DIR", defaultCredDir)
	_ = os.Setenv("PLATFORM_ENV_FILE", defaultEnvFile)
	_ = os.Setenv("PLATFORM_RECOVER_WORKING_OUT", workingOut)
	_ = os.Setenv("PLATFORM_RECOVER_RD_OLD", firstFilled(
		kubeSecretValue("platform", "platform-rotate-pending", "REDIS_PASSWORD_OLD"),
		kubeSecretValue("databases", "redis", "redis-password"),
		kubeSecretValue("platform", "platform-env", "REDIS_PASSWORD"),
	))

	if err := shell.RunBash(recoverScript); err != nil {
		return fmt.Errorf("recover failed (backup kept at %s): %w", backupDir, err)
	}

	if data, err := os.ReadFile(workingOut); err == nil {
		if w := strings.TrimSpace(string(data)); w != "" {
			pgPass = w
			cfg.PostgresPassword = w
			_ = PersistLocalCredentials(defaultEnvFile, defaultCredDir, map[string]string{
				"POSTGRES_PASSWORD": w,
				"ADMIN_PASSWORD":    adminPass,
				"REDIS_PASSWORD":    rdPass,
			})
		}
	}

	email := cfg.AdminEmail
	if email == "" {
		email = "admin@pratyushes.dev"
	}
	color.Green("  ✓ Access restored")
	color.Cyan("\n  Passwords are on this machine (not only the terminal):")
	fmt.Printf("    Backup:      %s\n", backupDir)
	fmt.Printf("    Env file:    %s\n", defaultEnvFile)
	fmt.Printf("    Admin file:  %s/admin\n", defaultCredDir)
	fmt.Printf("    Postgres:    %s/postgres\n", defaultCredDir)
	color.Cyan("\n  Portal login:")
	fmt.Printf("    URL:      https://%s\n", cfg.Domain)
	fmt.Printf("    Email:    %s\n", email)
	fmt.Printf("    Password: %s\n", adminPass)
	fmt.Printf("    (same value as %s/admin)\n", defaultCredDir)
	color.Cyan("\n  Next:")
	fmt.Printf("    sudo platformctl update\n")
	return nil
}
