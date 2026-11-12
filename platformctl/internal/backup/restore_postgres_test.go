package backup

import (
	"archive/tar"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeRestoreEnv runs restore.sh branches for real (bash, tar, cp) with fake
// kubectl and database clients that append their arguments/stdin to a log.
// `kubectl exec <pod> -- bash -ec SCRIPT -- REMOTE` runs SCRIPT locally, so the
// quoting of the scripts sent into the database pods is exercised exactly.
func fakeRestoreEnv(t *testing.T) (src, remote, logf string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("needs a POSIX shell environment")
	}
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	src, remote, logf = filepath.Join(dir, "src"), filepath.Join(dir, "remote"), filepath.Join(dir, "calls.log")
	for _, d := range []string{bin, src} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	fake := map[string]string{
		"kubectl": `args=()
while [ "$#" -gt 0 ]; do
  if [ "$1" = -c ]; then shift 2; else args+=("$1"); shift; fi
done
set -- "${args[@]}"
case "$3" in
  get) printf db-0 ;;
  cp) cp "$4" "${5#db-0:}" ;;
  exec)
    if [ "$6" = mktemp ]; then mkdir -p "$FAKE_REMOTE"; printf %s "$FAKE_REMOTE";
    elif [ "$6" = rm ]; then :;
    else shift 5; exec "$@"; fi ;;
  *) echo "unexpected kubectl $*" >&2; exit 1 ;;
esac`,
		"psql": `case " $* " in
  *" -Atc "*|*" -c "*) for a; do last=$a; done; printf 'psql-c %s\n' "$last" >> "$FAKE_LOG"; printf 0 ;;
  *) printf 'psql-stdin-begin\n' >> "$FAKE_LOG"; cat >> "$FAKE_LOG"; printf 'psql-stdin-end\n' >> "$FAKE_LOG" ;;
esac`,
		"pg_restore":   `printf 'pg_restore %s\n' "$*" >> "$FAKE_LOG"`,
		"mongorestore": `printf 'mongorestore %s\n' "$*" >> "$FAKE_LOG"`,
	}
	for name, body := range fake {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/usr/bin/env bash\nset -eu\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("FAKE_LOG", logf)
	t.Setenv("FAKE_REMOTE", remote)
	return src, remote, logf
}

func readLog(t *testing.T, logf string) string {
	t.Helper()
	b, _ := os.ReadFile(logf)
	return string(b)
}

// Regression: restore.sh embedded single quotes as ''' inside the single-quoted
// script passed to `kubectl exec ... bash -ec`, which unquoted the sed program
// ("unterminated address regex") and the SQL literal, so every Postgres
// restore failed.
func TestRestorePostgresBranchRuns(t *testing.T) {
	src, remote, logf := fakeRestoreEnv(t)
	globals := "CREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER PASSWORD 'old';\nCREATE ROLE platform;\nALTER ROLE platform WITH LOGIN PASSWORD 'p';\n"
	if err := os.WriteFile(filepath.Join(src, "globals.sql"), []byte(globals), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(src, "databases.tar"))
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(f)
	_ = tw.WriteHeader(&tar.Header{Name: "platform.dump", Mode: 0o600, Size: 4})
	_, _ = tw.Write([]byte("PGDM"))
	_ = tw.Close()
	_ = f.Close()
	t.Setenv("POSTGRES_PASSWORD", "current")

	if err := runScript(restoreScript, "postgres", src, ""); err != nil {
		t.Fatalf("postgres restore branch failed: %v", err)
	}
	log := readLog(t, logf)
	first := log[strings.Index(log, "psql-stdin-begin"):strings.Index(log, "psql-stdin-end")]
	if strings.Contains(first, "ROLE postgres") || !strings.Contains(first, "CREATE ROLE platform;") {
		t.Fatalf("globals must be applied without the bootstrap superuser lines:\n%s", log)
	}
	if !strings.Contains(log, "datname <> 'template1'") {
		t.Fatalf("session cleanup query lost its quoting:\n%s", log)
	}
	if !strings.Contains(log, "pg_restore -U postgres -d template1 --clean --if-exists --create --exit-on-error "+filepath.Join(remote, "platform.dump")) {
		t.Fatalf("dump not restored:\n%s", log)
	}
	if !strings.HasSuffix(strings.TrimSpace(log), "ALTER ROLE postgres WITH SUPERUSER PASSWORD 'old';\npsql-stdin-end") {
		t.Fatalf("original superuser credentials must be restored last:\n%s", log)
	}
}

// Regression: a single `mongorestore --drop` replaced admin.system.users
// before the data, deleting the user the session authenticated as; the rest
// failed with "requires authentication". Data first, users and roles last.
func TestRestoreMongoRestoresUsersLast(t *testing.T) {
	src, remote, logf := fakeRestoreEnv(t)
	if err := os.WriteFile(filepath.Join(src, "mongo.archive.gz"), []byte("archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MONGODB_ROOT_PASSWORD", "current")

	if err := runScript(restoreScript, "mongo", src, ""); err != nil {
		t.Fatalf("mongo restore branch failed: %v", err)
	}
	calls := strings.Split(strings.TrimSpace(readLog(t, logf)), "\n")
	if len(calls) != 2 {
		t.Fatalf("expected two mongorestore passes, got:\n%s", strings.Join(calls, "\n"))
	}
	archive := "--archive=" + filepath.Join(remote, "mongo.archive.gz")
	if !strings.Contains(calls[0], "--drop --nsExclude=admin.system.*") || !strings.Contains(calls[0], archive) || strings.Contains(calls[0], "--nsInclude") {
		t.Fatalf("first pass must restore data only:\n%s", calls[0])
	}
	if !strings.Contains(calls[1], "--drop --nsInclude=admin.system.users --nsInclude=admin.system.roles") || !strings.Contains(calls[1], archive) {
		t.Fatalf("second pass must restore users and roles:\n%s", calls[1])
	}
	if !strings.Contains(calls[0], "--password current") {
		t.Fatalf("restore must authenticate with the running cluster's root password:\n%s", calls[0])
	}
}
