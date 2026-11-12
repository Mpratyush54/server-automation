package components

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
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

// secretDataJSONPath builds the kubectl jsonpath expression for one Secret data
// key. Dots must be escaped: recent kubectl releases treat an unescaped dot
// inside ['...'] as a path separator, so `{.data['ca.crt']}` resolves to
// nothing while `{.data['ca\.crt']}` returns the value.
func secretDataJSONPath(key string) string {
	key = strings.ReplaceAll(key, `.`, `\.`)
	return "{.data['" + key + "']}"
}

func kubeSecretValue(ns, name, key string) string {
	// Inside bash double quotes a backslash before "." is kept literally, so the
	// escaped jsonpath reaches kubectl unchanged.
	script := fmt.Sprintf(`
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
kubectl -n %s get secret %s -o jsonpath="%s" 2>/dev/null | base64 -d 2>/dev/null || true
`, ns, name, secretDataJSONPath(key))
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

` + pgPrimaryPodShell + `
pg_primary_pod
if [[ -z "$PG_POD" ]]; then PG_POD=postgresql-0; fi
echo "  · using Postgres pod $PG_POD"

kubectl -n databases exec "$PG_POD" -c "$PG_CONTAINER" -- bash -lc '
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
  local host=""
  [[ "$PG_CONTAINER" != postgres ]] || host="-h 127.0.0.1"
  if [[ "${1:-}" == -f && "${2:-}" == 'platformctl-recover-admin.sql' ]]; then
    extra='-f "${TMPDIR:-/tmp}/platformctl-recover-admin.sql"'
  else
    extra=$(printf '%q ' "$@")
  fi
  kubectl -n databases exec "$PG_POD" -c "$PG_CONTAINER" -- bash -lc \
    "export PGPASSWORD=\$(printf '%s' '$pw_b64' | base64 -d 2>/dev/null || printf '%s' '$pw_b64' | base64 -D); exec psql $host -w -U postgres -d $(printf '%q' "$db") -v ON_ERROR_STOP=1 $extra"
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
  kubectl -n databases exec "$PG_POD" -c "$PG_CONTAINER" -- bash -lc '
    set -euo pipefail
    HBA="$(find /opt/bitnami /bitnami -name pg_hba.conf -print -quit 2>/dev/null || true)"
    [ -n "$HBA" ] || exit 1
    cp "$HBA" /tmp/pg_hba.recover.bak
    { echo "local all all trust"; echo "host all all 127.0.0.1/32 trust"; echo "host all all ::1/128 trust"; cat /tmp/pg_hba.recover.bak; } > "$HBA"
    PGDATA="${POSTGRESQL_DATA_DIR:-${PGDATA:-/bitnami/postgresql/data}}"
    pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || /opt/bitnami/postgresql/bin/pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || kill -HUP 1 >/dev/null 2>&1
  '
}

restore_trust() {
  kubectl -n databases exec "$PG_POD" -c "$PG_CONTAINER" -- bash -lc '
    set -euo pipefail
    [ -f /tmp/pg_hba.recover.bak ] || exit 0
    HBA="$(find /opt/bitnami /bitnami -name pg_hba.conf -print -quit 2>/dev/null || true)"
    [ -n "$HBA" ] || exit 1
    cp /tmp/pg_hba.recover.bak "$HBA"
    PGDATA="${POSTGRESQL_DATA_DIR:-${PGDATA:-/bitnami/postgresql/data}}"
    pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || /opt/bitnami/postgresql/bin/pg_ctl reload -D "$PGDATA" >/dev/null 2>&1 || kill -HUP 1 >/dev/null 2>&1
  '
}

USED_TRUST=0
TRUST_ACTIVE=0
restore_on_exit() {
 local rc=$?
 trap - EXIT
 if [[ "$TRUST_ACTIVE" == 1 ]]; then
  restore_trust || { echo "Failed to restore Postgres authentication; restore pg_hba.conf from its backup immediately" >&2; rc=2; }
 fi
 exit "$rc"
}
trap restore_on_exit EXIT
if [[ -z "$WORKING" && "$PG_CONTAINER" == postgres ]]; then
  echo "  · no stored password worked — updating the CloudNativePG superuser Secret (the operator applies it)"
  persist_pg_now "$PG_TARGET"
  PG_B64="$(b64 "$PG_TARGET")"
  printf '{"data":{"password":"%s","postgres-password":"%s"}}' "$PG_B64" "$PG_B64" | kubectl -n databases patch secret postgresql --type merge --patch-file=/dev/stdin
  for _ in $(seq 1 30); do
    if psql_with_pw "$PG_TARGET" postgres -tAc "SELECT 1" >/dev/null 2>&1; then WORKING="$PG_TARGET"; break; fi
    sleep 2
  done
  [[ -n "$WORKING" ]] || { echo "CNPG did not apply the superuser Secret within 60s" >&2; exit 2; }
fi
if [[ -z "$WORKING" ]]; then
  echo "  · no stored password worked — will ALTER only after passwords are on disk"
  persist_pg_now "$PG_TARGET"
  TRUST_ACTIVE=1
  enable_trust || { echo "  ✗ could not enable local trust (pg_hba.conf not found)" >&2; exit 2; }
  USED_TRUST=1
  sleep 2
  if ! kubectl -n databases exec "$PG_POD" -c "$PG_CONTAINER" -- psql -w -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    restore_trust
    echo "  ✗ could not authenticate to Postgres" >&2
    exit 2
  fi
  echo "  · authenticated via local trust; setting role password to the on-disk value"
  kubectl -n databases exec -i "$PG_POD" -c "$PG_CONTAINER" -- bash -lc 'cat > "${TMPDIR:-/tmp}/platformctl-recover-alter.sql"' < "$ALTER_FILE"
  kubectl -n databases exec "$PG_POD" -c "$PG_CONTAINER" -- bash -lc 'exec psql -w -U postgres -d postgres -v ON_ERROR_STOP=1 -f "${TMPDIR:-/tmp}/platformctl-recover-alter.sql"'
  restore_trust
  TRUST_ACTIVE=0
  if ! psql_with_pw "$PG_TARGET" postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "  ✗ ALTER USER ran but on-disk password still does not authenticate — leaving backup in place" >&2
    exit 2
  fi
  WORKING="$PG_TARGET"
fi

# Credentials live in platform-credentials (issue #20). Older installs kept
# them in platform-env; update that copy too only when it still has the key.
set_platform_credential() {
  local key="$1" b64val="$2"
  kubectl -n platform get secret platform-credentials >/dev/null 2>&1 \
    || kubectl -n platform create secret generic platform-credentials >/dev/null
  kubectl -n platform patch secret platform-credentials --type merge -p "{\"data\":{\"$key\":\"$b64val\"}}"
  if [[ -n "$(kubectl -n platform get secret platform-env -o jsonpath="{.data.$key}" 2>/dev/null || true)" ]]; then
    kubectl -n platform patch secret platform-env --type merge -p "{\"data\":{\"$key\":\"$b64val\"}}" || true
  fi
}

# Never ALTER when we already had a working password — sync Kubernetes to it.
PG_B64="$(b64 "$WORKING")"
set_platform_credential POSTGRES_PASSWORD "$PG_B64"
kubectl -n databases patch secret postgresql --type merge -p "{\"data\":{\"postgres-password\":\"$PG_B64\",\"password\":\"$PG_B64\"}}" || true

kubectl -n databases exec -i "$PG_POD" -c "$PG_CONTAINER" -- bash -lc 'cat > "${TMPDIR:-/tmp}/platformctl-recover-admin.sql"' < "$SQL_FILE"
psql_with_pw "$WORKING" platform -f platformctl-recover-admin.sql >/dev/null

if [[ -n "$RD_PASS" ]]; then
  RD_B64="$(b64 "$RD_PASS")"
  set_platform_credential REDIS_PASSWORD "$RD_B64" || true
  kubectl -n databases patch secret redis --type merge -p "{\"data\":{\"redis-password\":\"$RD_B64\"}}" || true
  if kubectl -n databases get sts redis-node >/dev/null 2>&1; then
    echo "  · Redis Sentinel mode: restarting redis-node so every node and sentinel re-read the password"
    kubectl -n databases rollout restart sts/redis-node
    kubectl -n databases rollout status sts/redis-node --timeout=300s
  else
    RD_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=redis -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [[ -z "$RD_POD" ]]; then RD_POD=redis-master-0; fi
    echo "  · using Redis pod $RD_POD"
    kubectl -n databases exec "$RD_POD" -- redis-cli CONFIG SET requirepass "$RD_PASS" >/dev/null 2>&1 \
      || kubectl -n databases exec "$RD_POD" -- redis-cli -a "$RD_OLD" CONFIG SET requirepass "$RD_PASS" >/dev/null 2>&1 \
      || kubectl -n databases exec "$RD_POD" -- redis-cli -a "$RD_PASS" CONFIG SET requirepass "$RD_PASS" >/dev/null 2>&1 \
      || echo "  · Redis CONFIG SET skipped (pod not ready)"
  fi
fi

ADMIN_B64="$(b64 "${PLATFORM_RECOVER_ADMIN_PASS}")"
set_platform_credential ADMIN_PASSWORD "$ADMIN_B64" || true

kubectl -n platform delete secret platform-rotate-pending --ignore-not-found >/dev/null 2>&1 || true
kubectl -n platform rollout restart deployment/platform-api
kubectl -n platform rollout status deployment/platform-api --timeout=180s
`

// RecoverAccess restores Postgres/Redis credentials and admin login from the
// k3s host. It backs up and writes passwords to the /etc/platform break-glass
// copy before any ALTER, then syncs the platform-credentials Secret the API reads.
func RecoverAccess(cfg *config.Config) error {
	color.Cyan("\n  ■ Recovering platform access\n")
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")

	backupDir, err := BackupLocalState(defaultBackupRoot, defaultEnvFile)
	if err != nil {
		return fmt.Errorf("refusing to continue without a local backup: %w", err)
	}
	color.Green("  ✓ backup written to %s", backupDir)

	// The host copy may predate a portal rotation (the API writes Secrets, not
	// host files): adopt the cluster's current values first when readable.
	if err := SyncCredentialsFromCluster(cfg); err != nil {
		color.Yellow("  · could not read platform Secrets (%v); using the host copy", err)
	}

	candidates := uniqueFilled(
		cfg.PostgresPassword,
		kubeSecretValue("platform", platformCredsSecret, "POSTGRES_PASSWORD"),
		kubeSecretValue("platform", platformCredsSecret, "POSTGRES_PASSWORD_NEXT"),
		kubeSecretValue("platform", platformCredsSecret, "POSTGRES_PASSWORD_PREV"),
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
		kubeSecretValue("platform", platformCredsSecret, "REDIS_PASSWORD"),
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

	tmpDir, err := os.MkdirTemp("", "platformctl-recover-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmpDir)
	sqlPath := filepath.Join(tmpDir, "admin.sql")
	alterPath := filepath.Join(tmpDir, "alter.sql")
	candPath := filepath.Join(tmpDir, "candidates")
	workingOut := filepath.Join(tmpDir, "working")
	alterSQL := fmt.Sprintf("ALTER USER postgres WITH PASSWORD '%s';\n", sqlLiteral(pgPass))
	adminSQL := fmt.Sprintf(
		"BEGIN;\nUPDATE users SET password_hash = '%s', is_active = true WHERE role = 'admin';\nDO $recover$ BEGIN IF NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin') OR EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND (password_hash <> '%s' OR is_active IS DISTINCT FROM true)) THEN RAISE EXCEPTION 'Admin password verification failed'; END IF; END $recover$;\nCOMMIT;\n",
		sqlLiteral(string(hash)), sqlLiteral(string(hash)),
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
	_ = os.Setenv("PLATFORM_RECOVER_ADMIN_PASS", adminPass)
	_ = os.Setenv("PLATFORM_CRED_DIR", defaultCredDir)
	_ = os.Setenv("PLATFORM_ENV_FILE", defaultEnvFile)
	_ = os.Setenv("PLATFORM_RECOVER_WORKING_OUT", workingOut)
	_ = os.Setenv("PLATFORM_RECOVER_RD_OLD", firstFilled(
		kubeSecretValue("platform", "platform-rotate-pending", "REDIS_PASSWORD_OLD"),
		kubeSecretValue("databases", "redis", "redis-password"),
		kubeSecretValue("platform", platformCredsSecret, "REDIS_PASSWORD"),
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
