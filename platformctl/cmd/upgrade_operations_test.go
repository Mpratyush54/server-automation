package cmd

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestActiveOperationsCommandsAndResults(t *testing.T) {
	old := upgradeRun
	t.Cleanup(func() { upgradeRun = old })
	for _, tt := range []struct {
		name, raw, want string
		fail            int
	}{
		{name: "empty", raw: `{"count":0,"recent":[]}`},
		{name: "large history is irrelevant", raw: `{"count":0,"recent":[]}`},
		{name: "active", raw: `{"count":1234,"recent":[{"type":"deploy","status":"running","updatedAt":"2026-11-09T04:00:00Z"},{"type":"rotate","status":"compensating","updatedAt":"2026-11-08T04:00:00Z"}]}`, want: "1234 active operations"},
		{name: "malformed", raw: `oops`, want: "parse active operations"},
		{name: "missing count", raw: `{}`, want: "invalid active operations"},
		{name: "negative", raw: `{"count":-1}`, want: "invalid active operations"},
		{name: "missing details", raw: `{"count":1}`, want: "invalid active operations"},
		{name: "lookup failed", fail: 1, want: "find PostgreSQL"},
		{name: "query failed", fail: 2, want: "query active operations"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			upgradeRun = func(name string, args ...string) (string, error) {
				calls++
				want := []string{"-n", "databases", "get", "pods", "-l", "app.kubernetes.io/name=postgresql", "-o", "jsonpath={.items[0].metadata.name}"}
				if calls == 2 {
					want = []string{"-n", "databases", "exec", "postgresql-0", "-c", "postgresql", "--", "bash", "-ec", operationsShell, "--", operationsSQL}
				}
				if name != "kubectl" || !reflect.DeepEqual(args, want) {
					t.Fatalf("unexpected command %s %q", name, args)
				}
				if calls == tt.fail {
					return "", errors.New("offline")
				}
				if calls == 1 {
					return "postgresql-0", nil
				}
				return tt.raw, nil
			}
			err := checkActiveOperations()
			if tt.want == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v; want %s", err, tt.want)
			}
			if tt.name == "active" {
				for _, detail := range []string{"type=deploy status=running updatedAt=2026-11-09T04:00:00Z", "type=rotate status=compensating"} {
					if !strings.Contains(err.Error(), detail) {
						t.Fatal(err)
					}
				}
			}
		})
	}
	upgradeRun = func(string, ...string) (string, error) { return "", nil }
	if err := checkActiveOperations(); err == nil {
		t.Fatal("accepted absent pod")
	}
	for _, fragment := range []string{"status IN ('pending','running','compensating')", "count(*) FROM active", `updated_at AS "updatedAt"`, "ORDER BY updated_at DESC LIMIT 5"} {
		if !strings.Contains(operationsSQL, fragment) {
			t.Fatalf("SQL missing %s", fragment)
		}
	}
}

func TestOperationsShellWithFakePsql(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal("bash required for shell quoting regression test")
	}
	for _, tt := range []struct {
		name, setup, exists string
		ok                  bool
	}{
		{"env", `export POSTGRES_PASSWORD="$EXPECTED_PASSWORD"`, "t", true},
		{"file", `unset POSTGRES_PASSWORD; f=$(mktemp); trap 'rm -f "$f"' EXIT; printf '%s' "$EXPECTED_PASSWORD" > "$f"; export POSTGRES_PASSWORD_FILE="$f"`, "t", true},
		{"env wins", `export POSTGRES_PASSWORD="$EXPECTED_PASSWORD" POSTGRES_PASSWORD_FILE=/does/not/exist`, "t", true},
		{"legacy missing table", `export POSTGRES_PASSWORD="$EXPECTED_PASSWORD"`, "f", true},
		{"query error", `export POSTGRES_PASSWORD="$EXPECTED_PASSWORD"; FAIL_QUERY=1`, "t", false},
		{"lookup error", `export POSTGRES_PASSWORD="$EXPECTED_PASSWORD"; FAIL_LOOKUP=1`, "t", false},
		{"bad table result", `export POSTGRES_PASSWORD="$EXPECTED_PASSWORD"`, "garbage", false},
		{"unreadable password file", `unset POSTGRES_PASSWORD; export POSTGRES_PASSWORD_FILE=/does/not/exist`, "t", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			script := `set -euo pipefail
exec() { "$@"; }
psql() {
 [[ "$PGPASSWORD" == "$EXPECTED_PASSWORD" ]] || return 91
 [[ "$#" == 11 && "$1" == -X && "$2" == -w && "$3" == -U && "$4" == postgres && "$5" == -d && "$6" == platform && "$7" == -At && "$8" == -v && "$9" == ON_ERROR_STOP=1 && "${10}" == -c ]] || return 92
 if [[ "${11}" == "SELECT to_regclass('public.operations') IS NOT NULL" ]]; then
  [[ "${FAIL_LOOKUP:-0}" == 0 ]] || return 93
  printf '%s' "$EXISTS"
 else
  [[ "$EXISTS" == t && "${11}" == "$EXPECTED_SQL" ]] || return 94
  [[ "${FAIL_QUERY:-0}" == 0 ]] || return 95
  printf '%s' '{"count":9,"recent":[{"type":"deploy","status":"pending","updatedAt":"now"}]}'
 fi
}
` + tt.setup + "\nset -- \"$EXPECTED_SQL\"\n" + operationsShell
			path := filepath.Join(t.TempDir(), "probe ' $ script.sh")
			if err := os.WriteFile(path, []byte(script), 0600); err != nil {
				t.Fatal(err)
			}
			c := exec.Command(bash, filepath.ToSlash(path))
			c.Env = append(os.Environ(), "EXPECTED_PASSWORD=spaces ' \" $() ` ; password", "EXPECTED_SQL="+operationsSQL, "EXISTS="+tt.exists)
			out, err := c.CombinedOutput()
			if (err == nil) != tt.ok {
				t.Fatalf("%v: %s", err, out)
			}
			if tt.ok && tt.exists == "f" && strings.TrimSpace(string(out)) != `{"count":0,"recent":[]}` {
				t.Fatalf("legacy result: %s", out)
			}
			if tt.ok && tt.exists == "t" && !strings.Contains(string(out), `"count":9`) {
				t.Fatalf("query result: %s", out)
			}
		})
	}
}
