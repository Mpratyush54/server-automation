package backup

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// TestPostgres restores each custom-format dump into a uniquely named scratch
// database, without applying globals, owners, ACLs or touching source databases.
func TestPostgres(target, id string, key []byte) error {
	return WithRestore(target, id, "postgres", key, func(m Manifest, dirs map[string]string) error {
		name := fmt.Sprintf("platform_restore_test_%d", time.Now().UnixNano())
		cmd := exec.Command("kubectl", "-n", "databases", "get", "pods", "-l", "cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary", "-o", "jsonpath={.items[0].metadata.name}")
		b, e := cmd.Output()
		container := "postgres"
		if e != nil || strings.TrimSpace(string(b)) == "" {
			container = "postgresql"
			cmd = exec.Command("kubectl", "-n", "databases", "get", "pods", "-l", "app.kubernetes.io/instance=postgresql", "-o", "jsonpath={.items[0].metadata.name}")
			b, e = cmd.Output()
		}
		if e != nil {
			return e
		}
		pod := strings.TrimSpace(string(b))
		if pod == "" {
			return fmt.Errorf("Postgres pod absent")
		}
		// Copy to a unique container directory, cleaned on both failure and success.
		b, e = exec.Command("kubectl", "-n", "databases", "exec", pod, "-c", container, "--", "mktemp", "-d").Output()
		if e != nil {
			return e
		}
		remote := strings.TrimSpace(string(b))
		if remote == "" {
			return fmt.Errorf("Postgres temporary directory absent")
		}
		run := func(args ...string) error {
			return exec.Command("kubectl", append([]string{"-n", "databases", "exec", pod, "-c", container, "--"}, args...)...).Run()
		}
		defer run("rm", "-rf", remote)
		cmd = exec.Command("kubectl", "-n", "databases", "cp", "-c", container, filepath.Join(dirs["postgres"], "databases.tar"), pod+":"+remote+"/databases.tar")
		if e = cmd.Run(); e != nil {
			return e
		}
		script := `set -euo pipefail
pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }
export PGPASSWORD="$(pw POSTGRES_PASSWORD)"
work=$1; db=$2
trap 'dropdb -U postgres --if-exists "$db"' EXIT
tar -C "$work" -xf "$work/databases.tar"
tested=0
for dump in "$work"/*.dump; do
  createdb -U postgres "$db"
  pg_restore -U postgres --dbname="$db" --no-owner --no-acl --exit-on-error "$dump"
  psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM pg_catalog.pg_class' >/dev/null
  # The platform database must contain core data, not merely valid SQL.
  if psql -U postgres -d "$db" -Atc "SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.projects') IS NOT NULL" | grep -qx t; then
    psql -U postgres -d "$db" -v ON_ERROR_STOP=1 -c 'SELECT id, email, password_hash FROM users LIMIT 1' -c 'SELECT count(*) FROM projects' >/dev/null
    psql -U postgres -d "$db" -At -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM users' | grep -Eq '^[1-9][0-9]*$'
    tested=1
  fi
  dropdb -U postgres "$db"
done
test "$tested" = 1
`
		return run("bash", "-ec", script, "--", remote, name)
	})
}
