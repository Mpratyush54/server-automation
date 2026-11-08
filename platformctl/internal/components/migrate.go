package components

// Database migrations before every API rollout (issue #17).
//
// The API no longer syncs its schema on boot. Each release ships versioned
// TypeORM migrations that `node dist/migrate.js` applies (under a Postgres
// advisory lock) from the platform-api image. platformctl runs that entrypoint
// as a short-lived Job after a pg_dump of the platform database and before the
// API Deployment changes; a failed Job stops the rollout so the running
// ReplicaSet keeps serving. The same bash function runs from `platformctl
// update` and from the digest auto-update CronJob (see digest.go), reading the
// Job manifest from a ConfigMap so all three paths render the same Job.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

const (
	migrateTemplateConfigMap = "platform-api-migrate-template"
	migrateDumpFile          = "platform.dump"
)

// migrateJobTemplate is the platform-api-migrate Job. __NAME__, __IMAGE__ and
// __BACKUP__ are filled in by run_api_migrations. Short-lived, same image as
// the API (already pulled), no service-account token, explicit limits.
const migrateJobTemplate = `apiVersion: batch/v1
kind: Job
metadata:
  name: __NAME__
  namespace: platform
  labels:
    app: platform-api-migrate
  annotations:
    platform.io/image: "__IMAGE__"
    platform.io/pre-migration-backup: "__BACKUP__"
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 900
  ttlSecondsAfterFinished: 604800
  template:
    metadata:
      labels:
        app: platform-api-migrate
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: migrate
        image: "__IMAGE__"
        imagePullPolicy: IfNotPresent
        command: ["node", "dist/migrate.js"]
        envFrom:
        - secretRef:
            name: platform-env
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
`

// migrateJobScript defines run_api_migrations IMAGE: render the Job from the
// template ConfigMap, wait for it, and fail (non-zero) if it fails or times
// out. The Job name is derived from the image reference, so a release whose
// Job already succeeded is not migrated again. MIGRATE_BACKUP (optional) is
// recorded in the Job annotations.
const migrateJobScript = `run_api_migrations() {
  local image="$1" name template state i
  name="platform-api-migrate-$(printf '%s' "$image" | sha256sum | cut -c1-12)"
  if [[ "$(kubectl -n platform get job "$name" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)" == "1" ]]; then
    echo "migrations already applied for $image ($name)"
    return 0
  fi
  template="$(kubectl -n platform get configmap platform-api-migrate-template -o jsonpath='{.data.template}')"
  [[ -n "$template" ]] || { echo "migration Job template missing; run: sudo platformctl update" >&2; return 1; }
  kubectl -n platform delete job "$name" --ignore-not-found --wait=true >/dev/null
  printf '%s\n' "$template" | sed -e "s|__NAME__|$name|g" -e "s|__IMAGE__|$image|g" -e "s|__BACKUP__|${MIGRATE_BACKUP:-none}|g" | kubectl apply -f - >/dev/null
  echo "running database migrations: job/$name"
  for ((i = 0; i < 240; i++)); do
    state="$(kubectl -n platform get job "$name" -o jsonpath='{.status.succeeded}/{.status.failed}' 2>/dev/null || true)"
    case "$state" in
      1/*) echo "migrations applied (job/$name)"; return 0 ;;
      */[1-9]*)
        kubectl -n platform logs "job/$name" --tail=50 >&2 || true
        echo "migration job/$name failed; API rollout stopped, the running version keeps serving" >&2
        return 1 ;;
    esac
    sleep 5
  done
  echo "timed out waiting for migration job/$name" >&2
  return 1
}
`

// pgDumpScript writes a custom-format pg_dump of the platform database to
// $DUMP. The password travels on stdin, never in argv.
const pgDumpScript = `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
PG_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$PG_POD" ]] || PG_POD=postgresql-0
umask 077
printf '%s\n' "$PGPW" | kubectl -n databases exec -i "$PG_POD" -- bash -c 'read -r PGPASSWORD; export PGPASSWORD; exec pg_dump -w -U postgres -d platform -Fc' > "$DUMP.partial"
[[ -s "$DUMP.partial" ]] || { echo "pg_dump produced no output" >&2; exit 1; }
mv "$DUMP.partial" "$DUMP"
`

// migrateTemplateManifest is the ConfigMap holding migrateJobTemplate.
func migrateTemplateManifest() string {
	b, _ := json.Marshal(map[string]any{
		"apiVersion": "v1",
		"kind":       "ConfigMap",
		"metadata": map[string]any{
			"name":      migrateTemplateConfigMap,
			"namespace": "platform",
			"labels":    map[string]string{"app": "platform-api-migrate"},
		},
		"data": map[string]string{"template": migrateJobTemplate},
	})
	return string(b)
}

// BackupPlatformDatabase takes the pre-migration backup: the usual
// BackupLocalState snapshot (.env + secrets) plus a pg_dump of the platform
// database in the same timestamped directory. Returns the dump path.
func BackupPlatformDatabase(cfg *config.Config, backupRoot string) (string, error) {
	dir, err := BackupLocalState(backupRoot, "")
	if err != nil {
		return "", fmt.Errorf("backup: %w", err)
	}
	dump := filepath.Join(dir, migrateDumpFile)
	if err := shell.RunBashEnv(pgDumpScript, map[string]string{"DUMP": dump, "PGPW": cfg.PostgresPassword}); err != nil {
		return "", fmt.Errorf("pg_dump of the platform database failed (rollout not started): %w", err)
	}
	return dump, nil
}

// prepareAPIMigrations installs the Job template and takes the pre-migration
// backup. Returns the dump path for the Job annotation.
func prepareAPIMigrations(cfg *config.Config) (string, error) {
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, migrateTemplateManifest()); err != nil {
		return "", fmt.Errorf("apply migration Job template: %w", err)
	}
	color.Cyan("  ■ Backing up the platform database before migrations...")
	// PLATFORMCTL_BACKUP_ROOT overrides /var/lib/platform/backups (tests use a temp dir).
	dump, err := BackupPlatformDatabase(cfg, os.Getenv("PLATFORMCTL_BACKUP_ROOT"))
	if err != nil {
		return "", err
	}
	color.Green("  ✓ Database backup: %s", dump)
	return dump, nil
}

// RunAPIMigrations backs up the database and runs the platform-api-migrate
// Job for image, returning an error (and so stopping the rollout) on failure.
// Call it before applying or changing the API Deployment.
func RunAPIMigrations(cfg *config.Config, image string) error {
	dump, err := prepareAPIMigrations(cfg)
	if err != nil {
		return err
	}
	color.Cyan("  ■ Applying database migrations...")
	script := "set -euo pipefail\nexport KUBECONFIG=\"${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}\"\n" + migrateJobScript + "run_api_migrations \"$API\"\n"
	if err := shell.RunBashEnv(script, map[string]string{"API": image, "MIGRATE_BACKUP": dump}); err != nil {
		return fmt.Errorf("database migrations failed; the API was not rolled: %w", err)
	}
	return nil
}
