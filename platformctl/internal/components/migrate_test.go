package components

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// migrateTools fakes kubectl for run_api_migrations. JOB_STATE is what the Job
// status reports ("1/" succeeded, "/1" failed); APPLIED records manifests.
const migrateTools = `set -euo pipefail
sleep() { :; }
kubectl() {
 case "$*" in
  "-n platform get job "*"{.status.succeeded}/{.status.failed}"*) printf '%s' "${JOB_STATE:-1/}" ;;
  "-n platform get job "*"{.status.succeeded}"*) printf '%s' "${ALREADY:-}" ;;
  "-n platform get deployment platform-api "*) printf '%s' "${CURRENT:-}" ;;
  "-n platform get configmap "*) printf '%s' "${TEMPLATE-$TPL}" ;;
  "-n platform delete job "*) echo deleted >> "$APPLIED.deletes" ;;
  "-n platform logs "*) echo "migration error detail" ;;
  "apply -f -") cat >> "$APPLIED" ;;
  *) echo "unexpected kubectl $*" >&2; return 97 ;;
 esac
}
`

func runMigrateScript(t *testing.T, env string) (string, string, error) {
	t.Helper()
	applied := filepath.Join(t.TempDir(), "applied")
	tplFile := filepath.Join(t.TempDir(), "tpl")
	if err := os.WriteFile(tplFile, []byte(migrateJobTemplate), 0600); err != nil {
		t.Fatal(err)
	}
	script := migrateTools + "APPLIED=" + shellQuote(filepath.ToSlash(applied)) + "\nTPL=\"$(cat " + shellQuote(filepath.ToSlash(tplFile)) + ")\"\n" + env + "\n" + migrateJobScript + "run_api_migrations ghcr.io/test/platform-api@sha256:abc\n"
	out, err := runJobShell(t, script)
	b, _ := os.ReadFile(applied)
	return out, string(b), err
}

func TestRunAPIMigrationsRendersAndWaitsForJob(t *testing.T) {
	out, manifest, err := runMigrateScript(t, "MIGRATE_BACKUP=/var/lib/platform/backups/x/platform.dump")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	for _, want := range []string{
		"name: platform-api-migrate-",
		`image: "ghcr.io/test/platform-api@sha256:abc"`,
		`platform.io/pre-migration-backup: "/var/lib/platform/backups/x/platform.dump"`,
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("applied Job missing %q:\n%s", want, manifest)
		}
	}
	if strings.Contains(manifest, "__") {
		t.Fatalf("unrendered placeholder in Job:\n%s", manifest)
	}
	if !strings.Contains(out, "migrations applied") {
		t.Fatalf("unexpected output: %s", out)
	}
}

// The periodic auto-update tick skips the Job only when nothing changed: the
// API already runs this image and its Job succeeded.
func TestRunAPIMigrationsCronSkipsNoOpTick(t *testing.T) {
	out, manifest, err := runMigrateScript(t, "ALREADY=1 CURRENT=ghcr.io/test/platform-api@sha256:abc")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if manifest != "" {
		t.Fatal("re-ran the Job on a no-op auto-update tick")
	}
}

// Regression (rollback to v1.2.0, then upgrade again): the v1.2.0 API dropped
// the new columns on boot, but the Job for the target image had succeeded
// before, so "migrations already applied" skipped the repair and the upgrade
// reported success with a broken schema.
func TestRunAPIMigrationsRerunsAfterRollback(t *testing.T) {
	for name, env := range map[string]string{
		"upgrade/provision always run": "ALREADY=1 CURRENT=ghcr.io/test/platform-api@sha256:abc MIGRATE_FORCE=1",
		"api runs another image":       "ALREADY=1 CURRENT=ghcr.io/test/platform-api@sha256:old",
	} {
		t.Run(name, func(t *testing.T) {
			out, manifest, err := runMigrateScript(t, env)
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if !strings.Contains(manifest, "kind: Job") {
				t.Fatalf("migration Job not re-run: %s", out)
			}
		})
	}
}

func TestRunAPIMigrationsFailureStopsRollout(t *testing.T) {
	out, _, err := runMigrateScript(t, "JOB_STATE=/1")
	if err == nil {
		t.Fatalf("failed migration Job reported success: %s", out)
	}
	if !strings.Contains(out, "migration error detail") || !strings.Contains(out, "rollout stopped") {
		t.Fatalf("failure must show Job logs and say the rollout stopped: %s", out)
	}
}

func TestRunAPIMigrationsTimesOut(t *testing.T) {
	if out, _, err := runMigrateScript(t, "JOB_STATE=/"); err == nil {
		t.Fatalf("pending Job treated as success: %s", out)
	}
}

func TestRunAPIMigrationsRequiresTemplate(t *testing.T) {
	out, manifest, err := runMigrateScript(t, "TEMPLATE=")
	if err == nil || manifest != "" {
		t.Fatalf("ran without a Job template: %s", out)
	}
}

func TestMigrateJobTemplateIsShortLivedAndLocked(t *testing.T) {
	for _, want := range []string{
		"kind: Job", "backoffLimit: 0", "activeDeadlineSeconds:", "ttlSecondsAfterFinished:",
		`command: ["node", "dist/migrate.js"]`, "name: platform-env", "restartPolicy: Never",
		"automountServiceAccountToken: false", "runAsNonRoot: true", "allowPrivilegeEscalation: false",
		`memory: "512Mi"`, "platform.io/pre-migration-backup",
	} {
		if !strings.Contains(migrateJobTemplate, want) {
			t.Errorf("migrate Job template missing %q", want)
		}
	}
	var cm struct {
		Kind     string
		Metadata struct{ Name, Namespace string }
		Data     map[string]string
	}
	if err := json.Unmarshal([]byte(migrateTemplateManifest()), &cm); err != nil {
		t.Fatal(err)
	}
	if cm.Kind != "ConfigMap" || cm.Metadata.Name != migrateTemplateConfigMap || cm.Metadata.Namespace != "platform" || cm.Data["template"] != migrateJobTemplate {
		t.Fatalf("bad template ConfigMap: %+v", cm)
	}
	if !strings.Contains(migrateJobScript, migrateTemplateConfigMap) {
		t.Fatal("script reads a different ConfigMap than platformctl writes")
	}
}

func TestPgDumpKeepsPasswordOffArgvAndWritesAtomically(t *testing.T) {
	dir := t.TempDir()
	dump := filepath.ToSlash(filepath.Join(dir, "platform.dump"))
	args := filepath.ToSlash(filepath.Join(dir, "args"))
	fake := "kubectl() { echo \"$*\" >> " + shellQuote(args) + "; if [[ \"$*\" == *\" exec \"* ]]; then read -r pw; [[ \"$pw\" == 's3cr$t pw' ]] || return 5; [[ \"${EMPTY:-}\" == 1 ]] || printf 'PGDMP'; fi; }\n"
	run := func(extra string) error {
		script := strings.Replace(pgDumpScript, "set -euo pipefail\n", "set -euo pipefail\n"+fake+extra, 1)
		_, err := runJobShell(t, "export DUMP="+shellQuote(dump)+" PGPW='s3cr$t pw'\n"+script)
		return err
	}
	if err := run(""); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.FromSlash(dump)); string(b) != "PGDMP" {
		t.Fatalf("dump not written: %q", b)
	}
	if b, _ := os.ReadFile(filepath.FromSlash(args)); strings.Contains(string(b), "s3cr$t") {
		t.Fatal("database password passed in kubectl arguments")
	}
	os.Remove(filepath.FromSlash(dump))
	if err := run("EMPTY=1\n"); err == nil {
		t.Fatal("empty pg_dump accepted")
	}
	if _, err := os.Stat(filepath.FromSlash(dump)); err == nil {
		t.Fatal("empty dump left at the final path")
	}
}

func TestInstallPlatformMigratesBeforeRollingAPI(t *testing.T) {
	calls := fakeTools(t)
	cfg := &config.Config{PostgresPassword: "pg-$(secret)", JWTSecret: strings.Repeat("j", 32), SecretsEncryptionKey: strings.Repeat("a", 64)}
	if err := InstallPlatform(cfg); err != nil {
		t.Fatal(err)
	}
	template, dump, migrate, deploy, creds, rbac := -1, -1, -1, -1, -1, -1
	for i, c := range calls() {
		if creds < 0 && strings.Contains(c.Input, "platform-credentials") && strings.Contains(c.Input, "Secret") {
			creds = i // #20: credentials Secret the migrate Job reads (envFrom)
		}
		if rbac < 0 && strings.Contains(c.Input, "platform-namespace-baseline") {
			rbac = i
		}
		joined := strings.Join(c.Args, " ")
		if strings.Contains(joined, cfg.PostgresPassword) {
			t.Fatal("Postgres password in tool arguments")
		}
		switch {
		case strings.Contains(c.Input, migrateTemplateConfigMap):
			template = i
		case c.Tool == "bash" && strings.Contains(joined, "pg_dump"):
			dump = i
		case c.Tool == "bash" && strings.Contains(joined, "run_api_migrations \"$API\""):
			migrate = i
		case c.Tool == "bash" && strings.Contains(joined, "name: platform-api") && strings.Contains(joined, "kind: Deployment"):
			deploy = i
		}
	}
	if template < 0 || dump < 0 || migrate < 0 || deploy < 0 {
		t.Fatalf("missing step: template=%d dump=%d migrate=%d deploy=%d", template, dump, migrate, deploy)
	}
	if !(template < dump && dump < migrate && migrate < deploy) {
		t.Fatalf("wrong order: template=%d dump=%d migrate=%d deploy=%d", template, dump, migrate, deploy)
	}
	if creds < 0 || rbac < 0 || !(creds < migrate && rbac < migrate) {
		t.Fatalf("credentials Secret (%d) and API RBAC (%d) must be applied before the migrate Job (%d)", creds, rbac, migrate)
	}
}
