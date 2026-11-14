package components

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
	"github.com/fatih/color"
)

// pgBackup is the archive destination. RegionKey, when set, names the key
// in Secret that holds the bucket region (external targets).
type pgBackup struct{ Destination, Endpoint, Secret, RegionKey string }

// pgRecovery bootstraps from the archive of ServerName. A zero Target
// replays all available WAL (recovery to the end of the archive).
type pgRecovery struct {
	Target     time.Time
	ServerName string
}
type pgClusterOptions struct {
	Backup     *pgBackup
	ServerName string
	Recovery   *pgRecovery
}

var pgDestinationRE = regexp.MustCompile(`^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](/[A-Za-z0-9._/-]*)?$`)
var pgEndpointRE = regexp.MustCompile(`^https?://[^\s]+$`)
var pgRetentionRE = regexp.MustCompile(`^[1-9][0-9]*[dwm]$`)

func pgDNSName(s string) bool {
	if s == "" || len(s) > 253 || !longhornSecretRE.MatchString(s) {
		return false
	}
	for _, label := range strings.Split(s, ".") {
		if len(label) > 63 {
			return false
		}
	}
	return true
}

func pgBackupTarget(cfg *config.Config) (*pgBackup, error) {
	sc := cfg.PostgresHAStorageClass
	if sc == "" {
		sc = "local-path"
	}
	if !pgDNSName(sc) {
		return nil, fmt.Errorf("POSTGRES_HA_STORAGE_CLASS must be a DNS-1123 name")
	}
	retention := cfg.PostgresBackupRetention
	if retention == "" {
		retention = "14d"
	}
	if !pgRetentionRE.MatchString(retention) {
		return nil, fmt.Errorf("POSTGRES_BACKUP_RETENTION must be a positive duration in d, w or m")
	}
	if cfg.PostgresBackupEndpoint != "" && !pgEndpointRE.MatchString(cfg.PostgresBackupEndpoint) {
		return nil, fmt.Errorf("POSTGRES_BACKUP_ENDPOINT must be an http(s) URL without whitespace")
	}
	if cfg.PostgresBackupSecret != "" && !pgDNSName(cfg.PostgresBackupSecret) {
		return nil, fmt.Errorf("POSTGRES_BACKUP_SECRET must be a DNS-1123 name")
	}
	if cfg.PostgresBackupDestination == "" {
		if cfg.BackupExternal() {
			// The off-site target (#186): WAL and base backups go next to the
			// encrypted archives, under <prefix>/postgres/.
			t := BackupTargetFromConfig(cfg)
			if err := t.ValidateSettings(); err != nil {
				return nil, err
			}
			return &pgBackup{t.PostgresDestination(), t.Endpoint, backup.PostgresTargetSecret, "REGION"}, nil
		}
		return &pgBackup{"s3://postgres-backups/", "http://minio.storage.svc.cluster.local:9000", "postgresql-backup-s3", ""}, nil
	}
	if !pgDestinationRE.MatchString(cfg.PostgresBackupDestination) {
		return nil, fmt.Errorf("POSTGRES_BACKUP_DESTINATION must be s3://<bucket>/<prefix>")
	}
	if cfg.PostgresBackupSecret == "" {
		return nil, fmt.Errorf("POSTGRES_BACKUP_DESTINATION requires POSTGRES_BACKUP_SECRET in databases")
	}
	return &pgBackup{cfg.PostgresBackupDestination, cfg.PostgresBackupEndpoint, cfg.PostgresBackupSecret, ""}, nil
}

func pgObjectStore(b *pgBackup, server string) map[string]any {
	creds := map[string]any{"accessKeyId": map[string]string{"name": b.Secret, "key": "ACCESS_KEY_ID"}, "secretAccessKey": map[string]string{"name": b.Secret, "key": "ACCESS_SECRET_KEY"}}
	if b.RegionKey != "" {
		creds["region"] = map[string]string{"name": b.Secret, "key": b.RegionKey}
	}
	m := map[string]any{"destinationPath": b.Destination, "serverName": server, "s3Credentials": creds}
	if b.Endpoint != "" {
		m["endpointURL"] = b.Endpoint
	}
	return m
}

const (
	// BarmanCloudPluginName is the CNPG-I plugin that archives WAL and takes base backups.
	BarmanCloudPluginName = "barman-cloud.cloudnative-pg.io"
	// PGObjectStoreName is the plugin ObjectStore holding the backup destination.
	PGObjectStoreName = "postgresql-backup"
)

// pgObjectStoreResource renders the plugin ObjectStore for the backup target.
// The serverName is per Cluster (plugin parameters), not part of the store.
func pgObjectStoreResource(cfg *config.Config, b *pgBackup) map[string]any {
	conf := pgObjectStore(b, "")
	delete(conf, "serverName")
	conf["wal"] = map[string]any{"compression": "gzip", "maxParallel": 2}
	conf["data"] = map[string]any{"compression": "gzip", "jobs": 2}
	retention := cfg.PostgresBackupRetention
	if retention == "" {
		retention = "14d"
	}
	return map[string]any{"apiVersion": "barmancloud.cnpg.io/v1", "kind": "ObjectStore",
		"metadata": map[string]any{"name": PGObjectStoreName, "namespace": "databases"},
		"spec":     map[string]any{"configuration": conf, "retentionPolicy": retention}}
}

const barmanPluginReadyScript = `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
timeout 5m kubectl wait --for=condition=Established crd/objectstores.barmancloud.cnpg.io --timeout=5m
timeout 5m kubectl -n cnpg-system wait --for=condition=Ready certificate/barman-cloud-server certificate/barman-cloud-client --timeout=5m
timeout 5m kubectl -n cnpg-system rollout status deploy/barman-cloud --timeout=5m
`

// ensureBarmanPlugin installs the Barman Cloud plugin (needs cert-manager)
// and waits until CNPG can call it. Overridable in tests.
var ensureBarmanPlugin = func() error {
	if out, err := shell.RunWithInput("kubectl", []string{"apply", "--server-side", "--force-conflicts", "-f", "-"}, readManifest("barman-cloud-plugin.yaml")); err != nil {
		return fmt.Errorf("install Barman Cloud plugin: %w: %s", err, out)
	}
	if err := shell.RunBash(barmanPluginReadyScript); err != nil {
		return fmt.Errorf("Barman Cloud plugin not ready: %w", err)
	}
	return nil
}

// applyPGBackupStore installs the plugin and applies the ObjectStore.
func applyPGBackupStore(cfg *config.Config, b *pgBackup) error {
	if err := ensureBarmanPlugin(); err != nil {
		return err
	}
	return applyTelemetryJSON(pgObjectStoreResource(cfg, b))
}

func pgResource(kind, name string) map[string]any {
	api := "postgresql.cnpg.io/v1"
	if kind == "Secret" || kind == "Service" || kind == "ConfigMap" {
		api = "v1"
	}
	return map[string]any{"apiVersion": api, "kind": kind, "metadata": map[string]any{"name": name, "namespace": "databases"}}
}

func renderPostgresCluster(cfg *config.Config, opts pgClusterOptions) (map[string]any, error) {
	if _, err := pgBackupTarget(cfg); err != nil {
		return nil, err
	}
	if opts.ServerName == "" {
		opts.ServerName = "postgresql"
	}
	sc := cfg.PostgresHAStorageClass
	if sc == "" {
		sc = "local-path"
	}
	instances := pgInstances(cfg)
	// PostgreSQL replicates itself. Longhorn's three replicas store each write
	// nine times and send WAL fsync over the network, without extra recovery
	// capacity when the three PostgreSQL instances already occupy three nodes.
	spec := map[string]any{
		// A deleted or drained primary waits smartShutdownTimeout for clients
		// to disconnect before failover can start. The API's connection pool
		// never disconnects on its own, so CNPG's 180 s default delayed
		// promotion by three minutes (measured on the 3-node test).
		"smartShutdownTimeout": 15,
		"instances":            instances, "imageName": versions.CNPGPostgresImage, "primaryUpdateStrategy": "unsupervised", "primaryUpdateMethod": "switchover", "enablePDB": true, "enableSuperuserAccess": true, "superuserSecret": map[string]string{"name": "postgresql"},
		"postgresql": map[string]any{"synchronous": map[string]any{"method": "any", "number": 1, "dataDurability": "preferred"}, "shared_preload_libraries": []string{"pgaudit", "pg_stat_statements"}, "parameters": map[string]string{"pg_stat_statements.max": "10000", "pg_stat_statements.track": "top", "max_connections": "200", "shared_buffers": "256MB", "archive_timeout": "5min"}},
		"bootstrap":  map[string]any{"initdb": map[string]string{"database": "platform", "owner": "platform"}},
		"storage":    map[string]string{"size": "10Gi", "storageClass": sc},
		"affinity":   map[string]any{"enablePodAntiAffinity": true, "podAntiAffinityType": "required", "topologyKey": "kubernetes.io/hostname"},
		"resources":  map[string]any{"requests": map[string]string{"cpu": "100m", "memory": "512Mi"}, "limits": map[string]string{"cpu": "2", "memory": "1Gi"}},
		"monitoring": map[string]any{"customQueriesConfigMap": []any{map[string]string{"name": "postgresql-monitoring", "key": "queries"}}},
	}
	if instances == 1 {
		// Single-node profiles (#183): one instance, no synchronous standby,
		// and no PodDisruptionBudget (it would block draining the only node).
		pg := spec["postgresql"].(map[string]any)
		delete(pg, "synchronous")
		pg["parameters"].(map[string]string)["shared_buffers"] = "128MB"
		spec["enablePDB"] = false
		spec["primaryUpdateMethod"] = "restart"
		spec["affinity"] = map[string]any{"enablePodAntiAffinity": false}
		spec["resources"] = map[string]any{"requests": map[string]string{"cpu": "50m", "memory": "256Mi"}, "limits": map[string]string{"cpu": "2", "memory": "1Gi"}}
	}
	if opts.Backup != nil {
		// WAL archiving and base backups through the Barman Cloud plugin
		// (#181); the destination lives in the ObjectStore (pgObjectStoreResource).
		spec["plugins"] = []any{map[string]any{"name": BarmanCloudPluginName, "isWALArchiver": true,
			"parameters": map[string]string{"barmanObjectName": PGObjectStoreName, "serverName": opts.ServerName}}}
	}
	if opts.Recovery != nil {
		if opts.Backup == nil {
			return nil, fmt.Errorf("PITR requires backup storage")
		}
		rec := map[string]any{"database": "platform", "owner": "platform", "source": "pitr-origin"}
		if !opts.Recovery.Target.IsZero() {
			rec["recoveryTarget"] = map[string]string{"targetTime": opts.Recovery.Target.Format(time.RFC3339)}
		}
		spec["bootstrap"] = map[string]any{"recovery": rec}
		spec["externalClusters"] = []any{map[string]any{"name": "pitr-origin", "plugin": map[string]any{"name": BarmanCloudPluginName,
			"parameters": map[string]string{"barmanObjectName": PGObjectStoreName, "serverName": opts.Recovery.ServerName}}}}
	}
	m := pgResource("Cluster", "postgresql")
	// The archive serverName is kept on the Cluster even before archiving is
	// configured, so later steps (and a re-provision) reuse it.
	m["metadata"].(map[string]any)["annotations"] = map[string]string{pgServerNameAnnotation: opts.ServerName}
	m["spec"] = spec
	return m, nil
}

// cnpgValues are the operator chart values. Single-node profiles run one
// operator replica (the second only helps when a node fails).
func cnpgValues(cfg *config.Config) string {
	v := readManifest("cnpg-values.yaml")
	if !cfg.IsHA() {
		v = strings.Replace(v, "replicaCount: 2", "replicaCount: 1", 1)
	}
	return v
}

// pgServerNameAnnotation records the archive serverName on the Cluster.
const pgServerNameAnnotation = "platform.io/backup-server-name"

// pgInstances is 3 on ha and 1 on the single-node profiles.
func pgInstances(cfg *config.Config) int {
	if cfg.IsHA() {
		return 3
	}
	return 1
}

// PostgresUsesCNPG reports whether PostgreSQL runs as a CloudNativePG
// cluster: always on ha and on fresh single-node installs; installs from
// before #186 keep the Bitnami release until `platformctl postgres migrate`.
func PostgresUsesCNPG(cfg *config.Config) bool {
	if cfg.IsHA() {
		return true
	}
	switch cfg.PostgresEngine {
	case config.PostgresEngineCNPG:
		return true
	case config.PostgresEngineBitnami:
		return false
	}
	return !state.IsDone("postgresql")
}

// ResolvePostgresEngine is the engine provision records in .env.
func ResolvePostgresEngine(cfg *config.Config) string {
	if PostgresUsesCNPG(cfg) {
		return config.PostgresEngineCNPG
	}
	return config.PostgresEngineBitnami
}

func pgAliasService() map[string]any {
	m := pgResource("Service", "postgresql")
	m["metadata"].(map[string]any)["labels"] = map[string]string{"app.kubernetes.io/part-of": "platform"}
	m["spec"] = map[string]any{"type": "ClusterIP", "selector": map[string]string{"cnpg.io/cluster": "postgresql", "cnpg.io/instanceRole": "primary"}, "ports": []any{map[string]any{"name": "postgres", "port": 5432, "targetPort": 5432}}}
	return m
}

func pgMonitoringConfigMap() map[string]any {
	m := pgResource("ConfigMap", "postgresql-monitoring")
	m["metadata"].(map[string]any)["labels"] = map[string]string{"cnpg.io/reload": ""}
	m["data"] = map[string]string{"queries": `project_database:
  query: "SELECT datname, numbackends AS connections, pg_database_size(datname) AS size_bytes FROM pg_stat_database WHERE datname LIKE 'plat_%'"
  primary: true
  metrics:
    - datname: {usage: LABEL, description: Database}
    - connections: {usage: GAUGE, description: Database connections}
    - size_bytes: {usage: GAUGE, description: Database bytes}
`}
	return m
}

const pgMigrationError = "an existing PostgreSQL Bitnami release `postgresql` was found; it is not converted in place. Move it to CloudNativePG with `sudo platformctl postgres migrate --confirm` (dump, restore and verify, with a pre-migration backup and a short downtime), then re-run provision"

func cnpgHelmScript(path string) string {
	return "set -euo pipefail\nexport KUBECONFIG=\"${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}\"\n" + helmLockHelper + "\nif kubectl get namespace cnpg-system >/dev/null 2>&1; then clear_helm_lock cnpg cnpg-system; fi\nhelm upgrade --install cnpg " + chart("cloudnative-pg") + " --namespace cnpg-system --create-namespace -f " + shellQuote(path) + " --wait --timeout 10m\ntimeout 5m kubectl -n cnpg-system rollout status deploy/cnpg-cloudnative-pg --timeout=5m\ntimeout 5m kubectl wait --for=condition=Established crd/clusters.postgresql.cnpg.io --timeout=5m\n"
}

func pgSecretExists(name string) (bool, error) {
	out, err := shell.Output("kubectl", "-n", "databases", "get", "secret", name, "--ignore-not-found", "-o", "name")
	return strings.TrimSpace(out) != "", err
}

func pgBackupOptions(cfg *config.Config) (*pgBackup, error) {
	b, err := pgBackupTarget(cfg)
	if err != nil {
		return nil, err
	}
	if cfg.PostgresBackupDestination != "" {
		return b, nil
	}
	if cfg.BackupExternal() {
		// Re-provision of a cluster that already archives: keep archiving.
		// A fresh install turns it on in the postgresql-backup step, after
		// cert-manager (the plugin needs it).
		out, err := shell.Output("kubectl", "-n", "databases", "get", "objectstores.barmancloud.cnpg.io", PGObjectStoreName, "--ignore-not-found", "-o", "name")
		if err != nil || strings.TrimSpace(out) == "" {
			return nil, nil
		}
		return b, nil
	}
	exists, err := pgSecretExists(b.Secret)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, nil
	}
	return b, nil
}

func pgLiveServerName() (string, error) {
	out, err := shell.Output("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql", "--ignore-not-found", "-o", "json")
	if err != nil {
		return "", err
	}
	return pgServerNameFromJSON(out, time.Now()), nil
}

// pgServerNameFromJSON picks the archive serverName: the live Cluster's
// (plugin, in-tree or annotation), "postgresql" for clusters from before the
// annotation, and a new unique name for a new cluster. A unique name keeps a
// rebuilt server from colliding with the old server's archive in the same
// bucket (Barman refuses to archive into a non-empty server folder).
func pgServerNameFromJSON(raw string, now time.Time) string {
	if strings.TrimSpace(raw) == "" {
		return pgNewServerName(now)
	}
	var c pgClusterState
	if json.Unmarshal([]byte(raw), &c) != nil {
		return "postgresql"
	}
	if n, ok := c.pluginServerName(); ok {
		return n
	}
	if s := c.Spec.Backup.BarmanObjectStore; s != nil && s.ServerName != "" {
		return s.ServerName
	}
	if n := c.Metadata.Annotations[pgServerNameAnnotation]; n != "" {
		return n
	}
	return "postgresql"
}

func pgNewServerName(now time.Time) string {
	return "postgresql-" + strings.ToLower(now.UTC().Format("20060102t1504"))
}

func applyPGCluster(cfg *config.Config, opts pgClusterOptions) error {
	m, err := renderPostgresCluster(cfg, opts)
	if err != nil {
		return err
	}
	// The deployment can be ready before the webhook endpoint is published.
	deadline := time.Now().Add(2 * time.Minute)
	for {
		err = applyTelemetryJSON(m)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("apply PostgreSQL Cluster (check CNPG webhook readiness): %w", err)
		}
		time.Sleep(5 * time.Second)
	}
}

const pgPrimaryReadyScript = `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
timeout 10m bash -c '
until ready=$(kubectl -n databases get clusters.postgresql.cnpg.io postgresql --request-timeout=30s -o jsonpath={.status.readyInstances}) &&
      [ "${ready:-0}" -ge 1 ] &&
      kubectl -n databases wait --for=condition=Ready pod -l cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary --timeout=30s; do
  sleep 5
done
'
`

// InstallPostgresHA installs the CloudNativePG cluster on the ha profile.
func InstallPostgresHA(cfg *config.Config) error {
	if !cfg.IsHA() {
		return nil
	}
	return installPostgresCNPG(cfg)
}

// installPostgresCNPG installs the operator, the Barman Cloud plugin when
// archiving is already configured, and the postgresql Cluster (3 instances on
// ha, 1 on single-node profiles), with the postgresql alias Service the
// platform connects to (POSTGRES_HOST=postgresql.databases on every profile).
func installPostgresCNPG(cfg *config.Config) error {
	if _, err := pgBackupTarget(cfg); err != nil {
		return err
	}
	sts, err := shell.Output("kubectl", "-n", "databases", "get", "statefulset", "postgresql", "--ignore-not-found", "-o", "name")
	if err != nil {
		return err
	}
	if strings.TrimSpace(sts) != "" || shell.RunSilent("helm", "status", "postgresql", "-n", "databases") == nil {
		return errors.New(pgMigrationError)
	}
	managed, err := shell.Output("kubectl", "-n", "databases", "get", "service", "postgresql", "--ignore-not-found", "-o", "jsonpath={.metadata.labels.app\\.kubernetes\\.io/managed-by}")
	if err != nil {
		return err
	}
	if strings.TrimSpace(managed) == "Helm" {
		return errors.New(pgMigrationError)
	}
	sc := cfg.PostgresHAStorageClass
	if sc == "" {
		sc = LocalPathStorageClass
	}
	// local-path is no longer the default on ha (Longhorn is), but it must still exist.
	if out, err := shell.Output("kubectl", "get", "storageclass", sc, "-o", "name"); err != nil {
		return fmt.Errorf("PostgreSQL StorageClass %q not found (POSTGRES_HA_STORAGE_CLASS): %w: %s", sc, err, out)
	}
	f, err := os.CreateTemp("", "cnpg-values-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.WriteString(cnpgValues(cfg))
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err = shell.RunBash(cnpgHelmScript(f.Name())); err != nil {
		return fmt.Errorf("install CloudNativePG: %w", err)
	}
	if err = applyTelemetryJSON(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]string{"name": "databases"}}); err != nil {
		return err
	}
	exists, err := pgSecretExists("postgresql")
	if err != nil {
		return err
	}
	if !exists {
		m := pgResource("Secret", "postgresql")
		m["type"] = "kubernetes.io/basic-auth"
		m["stringData"] = map[string]string{"username": "postgres", "password": cfg.PostgresPassword, "postgres-password": cfg.PostgresPassword}
		if err = applyTelemetryJSON(m); err != nil {
			return err
		}
	}
	if err = applyTelemetryJSON(pgMonitoringConfigMap()); err != nil {
		return err
	}
	b, err := pgBackupOptions(cfg)
	if err != nil {
		return err
	}
	server, err := pgLiveServerName()
	if err != nil {
		return err
	}
	if b != nil {
		// Re-provision of a cluster that already archives: keep the plugin
		// and ObjectStore in place before the Cluster references them.
		if err = applyPGBackupStore(cfg, b); err != nil {
			return err
		}
	}
	if err = applyPGCluster(cfg, pgClusterOptions{Backup: b, ServerName: server}); err != nil {
		return err
	}
	if err = applyTelemetryJSON(pgAliasService()); err != nil {
		return err
	}
	if err = shell.RunBash(pgPrimaryReadyScript); err != nil {
		return fmt.Errorf("PostgreSQL primary readiness: %w", err)
	}
	ready, _ := shell.Output("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql", "-o", "jsonpath={.status.readyInstances}/{.spec.instances}")
	want := fmt.Sprintf("%d/%d", pgInstances(cfg), pgInstances(cfg))
	if r := strings.TrimSpace(ready); r != want {
		color.Yellow("  PostgreSQL: %s instances ready; standbys stay Pending until enough nodes have joined (one instance per node)", r)
	} else {
		color.Green("  ✓ PostgreSQL (CloudNativePG) ready: %s instances", want)
	}
	return state.MarkDone("postgresql")
}

func pgBundledStorage(cfg *config.Config, b *pgBackup) error {
	exists, err := pgSecretExists(b.Secret)
	if err != nil {
		return err
	}
	if !exists {
		key := make([]byte, 32)
		if _, err = rand.Read(key); err != nil {
			return err
		}
		m := pgResource("Secret", b.Secret)
		m["stringData"] = map[string]string{"ACCESS_KEY_ID": "postgres-backup", "ACCESS_SECRET_KEY": hex.EncodeToString(key)}
		if err = applyTelemetryJSON(m); err != nil {
			return err
		}
	}
	m := pgResource("Secret", "postgresql-backup-bootstrap")
	m["stringData"] = map[string]string{"ROOT_USER": cfg.MinioAccessKey, "ROOT_PASSWORD": cfg.MinioSecretKey}
	if err = applyTelemetryJSON(m); err != nil {
		return err
	}
	defer shell.RunSilent("kubectl", "-n", "databases", "delete", "secret", "postgresql-backup-bootstrap", "--ignore-not-found")
	job := "postgresql-backup-storage"
	if err = shell.Run("kubectl", "-n", "databases", "delete", "job", job, "--ignore-not-found", "--wait=true"); err != nil {
		return err
	}
	env := []any{}
	for _, pair := range [][2]string{{"S3_ACCESS_KEY", "ACCESS_KEY_ID"}, {"S3_SECRET_KEY", "ACCESS_SECRET_KEY"}} {
		env = append(env, map[string]any{"name": pair[0], "valueFrom": map[string]any{"secretKeyRef": map[string]string{"name": b.Secret, "key": pair[1]}}})
	}
	container := map[string]any{"name": "mc", "image": telemetryMCImage, "command": []string{"/bin/sh", "-ec", minioBucketUserScript("postgres-backups", "postgres-backup", "S3_ACCESS_KEY", "S3_SECRET_KEY")}, "envFrom": []any{map[string]any{"secretRef": map[string]string{"name": "postgresql-backup-bootstrap"}}}, "env": env, "resources": map[string]any{"requests": map[string]string{"cpu": "25m", "memory": "64Mi"}, "limits": map[string]string{"cpu": "200m", "memory": "256Mi"}}}
	m = map[string]any{"apiVersion": "batch/v1", "kind": "Job", "metadata": map[string]string{"name": job, "namespace": "databases"}, "spec": map[string]any{"backoffLimit": 3, "activeDeadlineSeconds": 900, "ttlSecondsAfterFinished": 3600, "template": map[string]any{"spec": map[string]any{"restartPolicy": "Never", "containers": []any{container}}}}}
	if err = applyTelemetryJSON(m); err != nil {
		return err
	}
	return shell.RunBash(minioJobWaitScript("databases", job, 930))
}

func InstallPostgresBackup(cfg *config.Config) error {
	if !PostgresUsesCNPG(cfg) {
		color.Yellow("  PostgreSQL WAL archiving skipped: this install still runs the Bitnami release; move it to CloudNativePG with `sudo platformctl postgres migrate --confirm` for point-in-time recovery")
		return nil
	}
	b, err := pgBackupTarget(cfg)
	if err != nil {
		return err
	}
	if cfg.PostgresBackupDestination == "" && cfg.BackupExternal() {
		exists, e := pgSecretExists(b.Secret)
		if e != nil {
			return e
		}
		if !exists {
			return fmt.Errorf("the backup target Secret databases/%s is missing; run: sudo platformctl backup target set", b.Secret)
		}
	} else if cfg.PostgresBackupDestination != "" {
		exists, e := pgSecretExists(b.Secret)
		if e != nil {
			return e
		}
		if !exists {
			return fmt.Errorf("POSTGRES_BACKUP_SECRET %s must exist in namespace databases with ACCESS_KEY_ID and ACCESS_SECRET_KEY", b.Secret)
		}
	} else if err = pgBundledStorage(cfg, b); err != nil {
		return err
	}
	server, err := pgLiveServerName()
	if err != nil {
		return err
	}
	if err = applyPGBackupStore(cfg, b); err != nil {
		return err
	}
	if err = applyPGCluster(cfg, pgClusterOptions{Backup: b, ServerName: server}); err != nil {
		return err
	}
	// Archiving through the plugin proves the operator has registered it. The
	// ScheduledBackup's immediate run must not start earlier: on a fresh ha
	// install it failed with "requested plugin is not available" and left the
	// cluster without a base backup (no PITR possible).
	if err = shell.RunBash("timeout 10m kubectl -n databases wait --for=condition=ContinuousArchiving=True clusters.postgresql.cnpg.io/postgresql --timeout=10m"); err != nil {
		return fmt.Errorf("WAL archiving not ready; check kubectl -n databases describe cluster postgresql for archive errors: %w", err)
	}
	m := pgResource("ScheduledBackup", "postgresql-daily")
	m["spec"] = pgPluginBackupSpec(map[string]any{"schedule": "0 0 3 * * *", "backupOwnerReference": "self", "immediate": true})
	if err = applyTelemetryJSON(m); err != nil {
		return err
	}
	if err = shell.RunBash(pgFirstBackupScript); err != nil {
		return fmt.Errorf("first PostgreSQL base backup: %w", err)
	}
	if err = ApplyBackupAlerts(); err != nil {
		color.Yellow("  · backup alert rules not applied: %v", err)
	}
	return state.MarkDone("postgresql-backup")
}

// pgFirstBackupScript waits until a base backup exists in the recovery window.
// It requests one Backup when none completed (also after a failed attempt),
// and fails after 15 minutes with the backup's error.
const pgFirstBackupScript = `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
completed() { kubectl -n databases get backups.postgresql.cnpg.io -o jsonpath='{range .items[*]}{.spec.cluster.name}={.status.phase}{"\n"}{end}' 2>/dev/null | grep -qx 'postgresql=completed'; }
requested=""
for _ in $(seq 1 180); do
  completed && exit 0
  phases=$(kubectl -n databases get backups.postgresql.cnpg.io -o jsonpath='{range .items[*]}{.status.phase}{"\n"}{end}' 2>/dev/null || true)
  if [ -z "$requested" ] && printf '%s\n' "$phases" | grep -qx failed && ! printf '%s\n' "$phases" | grep -qxE 'running|started|pending|'; then
    name="postgresql-initial-$(date +%s)"
    kubectl apply -f - >/dev/null <<EOF
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata: {name: $name, namespace: databases}
spec: {cluster: {name: postgresql}, method: plugin, pluginConfiguration: {name: ` + BarmanCloudPluginName + `}}
EOF
    requested="$name"
  fi
  sleep 5
done
echo "no completed base backup after 15 minutes:" >&2
kubectl -n databases get backups.postgresql.cnpg.io -o custom-columns=NAME:.metadata.name,PHASE:.status.phase,ERROR:.status.error >&2 || true
exit 1
`

// pgPluginBackupSpec completes a Backup/ScheduledBackup spec for the plugin.
func pgPluginBackupSpec(spec map[string]any) map[string]any {
	spec["cluster"] = map[string]string{"name": "postgresql"}
	spec["method"] = "plugin"
	spec["pluginConfiguration"] = map[string]string{"name": BarmanCloudPluginName}
	return spec
}

func InstallPostgresMonitoring(cfg *config.Config) error {
	if !PostgresUsesCNPG(cfg) || !cfg.InstallMonitoring {
		color.Yellow("  postgresql-monitoring skipped (CloudNativePG with monitoring only)")
		return nil
	}
	if shell.RunSilent("kubectl", "get", "crd", "podmonitors.monitoring.coreos.com") != nil {
		color.Yellow("  PodMonitor CRD missing; re-run platformctl install postgresql-monitoring after installing monitoring")
		return nil
	}
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, readManifest("postgresql-ha-monitoring.yaml")); err != nil {
		return err
	}
	return state.MarkDone("postgresql-monitoring")
}

type pgClusterState struct {
	Metadata struct {
		Annotations map[string]string
	}
	Spec struct {
		Instances int
		Plugins   []struct {
			Name          string
			IsWALArchiver bool
			Parameters    map[string]string
		}
		Backup struct {
			BarmanObjectStore *struct {
				DestinationPath, EndpointURL, ServerName string
				S3Credentials                            struct {
					AccessKeyID     struct{ Name, Key string }
					SecretAccessKey struct{ Name, Key string }
				}
			}
		}
	}
	Status struct {
		Phase                                                          string
		ReadyInstances                                                 int
		CurrentPrimary, LastSuccessfulBackup, FirstRecoverabilityPoint string
		Conditions                                                     []struct{ Type, Status string }
	}
}

// pgObjectStoreState is the part of the plugin ObjectStore platformctl reads.
type pgObjectStoreState struct {
	Spec struct {
		Configuration struct {
			DestinationPath, EndpointURL string
			S3Credentials                struct {
				AccessKeyID     struct{ Name, Key string }
				SecretAccessKey struct{ Name, Key string }
				Region          struct{ Name, Key string }
			}
		}
	}
	Status struct {
		ServerRecoveryWindow map[string]struct {
			FirstRecoverabilityPoint, LastSuccessfulBackupTime string
		}
	}
}

// pluginServerName returns the archive serverName when the Cluster archives
// through the Barman Cloud plugin.
func (c pgClusterState) pluginServerName() (string, bool) {
	for _, p := range c.Spec.Plugins {
		if p.Name == BarmanCloudPluginName && p.IsWALArchiver {
			if n := p.Parameters["serverName"]; n != "" {
				return n, true
			}
			return "postgresql", true
		}
	}
	return "", false
}

// recoveryWindow returns the first recoverability point and last successful
// backup, from the ObjectStore (plugin) or the Cluster status (in-tree).
func (c pgClusterState) recoveryWindow(store *pgObjectStoreState) (first, last string) {
	if server, ok := c.pluginServerName(); ok {
		if store != nil {
			w := store.Status.ServerRecoveryWindow[server]
			return w.FirstRecoverabilityPoint, w.LastSuccessfulBackupTime
		}
		return "", ""
	}
	return c.Status.FirstRecoverabilityPoint, c.Status.LastSuccessfulBackup
}

func writePostgresHAStatus(w io.Writer, clusterJSON []byte, storeJSON ...[]byte) error {
	var c pgClusterState
	if err := json.Unmarshal(clusterJSON, &c); err != nil {
		return err
	}
	var store *pgObjectStoreState
	if len(storeJSON) > 0 && len(storeJSON[0]) > 0 {
		store = &pgObjectStoreState{}
		if err := json.Unmarshal(storeJSON[0], store); err != nil {
			store = nil
		}
	}
	fmt.Fprintf(w, "PostgreSQL (CloudNativePG): %s, %d/%d ready, primary %s\n", c.Status.Phase, c.Status.ReadyInstances, c.Spec.Instances, c.Status.CurrentPrimary)
	fmt.Fprintln(w, "  read-write: postgresql.databases:5432 (alias of postgresql-rw), read-only: postgresql-ro.databases:5432")
	archive := "not configured"
	_, plugin := c.pluginServerName()
	if c.Spec.Backup.BarmanObjectStore != nil || plugin {
		archive = "FAILING"
	}
	for _, cond := range c.Status.Conditions {
		if cond.Type == "ContinuousArchiving" {
			archive = "FAILING"
			if cond.Status == "True" {
				archive = "ok"
			}
		}
	}
	if plugin {
		archive += " (Barman Cloud plugin)"
	}
	fmt.Fprintln(w, "  WAL archiving:", archive)
	first, last := c.recoveryWindow(store)
	if last != "" {
		fmt.Fprintln(w, "  Last successful backup:", last)
	}
	if first != "" {
		fmt.Fprintln(w, "  First recoverability point:", first)
	}
	if c.Status.ReadyInstances < c.Spec.Instances {
		fmt.Fprintln(w, "  WARNING: PostgreSQL instances are not all ready")
	}
	return nil
}

func PrintPostgresHAStatus(w io.Writer) {
	out, err := shell.Output("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql", "-o", "json")
	if err == nil {
		store, _ := shell.Output("kubectl", "-n", "databases", "get", "objectstores.barmancloud.cnpg.io", PGObjectStoreName, "--ignore-not-found", "-o", "json")
		err = writePostgresHAStatus(w, []byte(out), []byte(strings.TrimSpace(store)))
	}
	if err != nil {
		color.New(color.FgRed).Fprintf(w, "PostgreSQL HA status: %v\n", err)
	}
}

func validatePGPITR(raw, storeRaw []byte, target, now time.Time) (pgClusterState, *pgObjectStoreState, error) {
	var c pgClusterState
	if !target.Before(now) {
		return c, nil, fmt.Errorf("PITR target must be in the past")
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, nil, err
	}
	if _, ok := c.pluginServerName(); !ok {
		if c.Spec.Backup.BarmanObjectStore != nil {
			return c, nil, fmt.Errorf("the cluster still archives with the in-tree barmanObjectStore; run `platformctl install postgresql-backup` to move it to the Barman Cloud plugin, then retry")
		}
		return c, nil, fmt.Errorf("PITR requires WAL archiving (Barman Cloud plugin); run `platformctl install postgresql-backup`")
	}
	store := &pgObjectStoreState{}
	if err := json.Unmarshal(storeRaw, store); err != nil || store.Spec.Configuration.DestinationPath == "" {
		return c, nil, fmt.Errorf("ObjectStore %s/%s is missing or unreadable", "databases", PGObjectStoreName)
	}
	firstRaw, _ := c.recoveryWindow(store)
	first, err := time.Parse(time.RFC3339, firstRaw)
	if err != nil {
		return c, nil, fmt.Errorf("firstRecoverabilityPoint is unavailable (no completed base backup yet?): %w", err)
	}
	if target.Before(first) {
		return c, nil, fmt.Errorf("PITR target precedes firstRecoverabilityPoint %s", first.Format(time.RFC3339))
	}
	return c, store, nil
}
func pgPITRServerName(now time.Time) string { return fmt.Sprintf("postgresql-pitr-%d", now.Unix()) }

// PITROptions selects the recovery point. Latest replays all archived WAL;
// SourceServer recovers from another server's archive in the same target
// (a rebuilt server restoring the old one's data).
type PITROptions struct {
	Target       time.Time
	Latest       bool
	SourceServer string
}

// RestorePostgresPITR recovers PostgreSQL to a point in time (every profile
// running CloudNativePG).
func RestorePostgresPITR(cfg *config.Config, target time.Time) error {
	return RestorePostgresPITRWith(cfg, PITROptions{Target: target})
}

var pgServerNameRE = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,62}$`)

// validatePGRecovery checks a recovery request against the live Cluster and
// ObjectStore. A specific time in the live server's archive must fall in its
// recovery window; Latest or another server's archive is checked by the
// operator while it bootstraps.
func validatePGRecovery(raw, storeRaw []byte, o PITROptions, now time.Time) (pgClusterState, *pgObjectStoreState, string, error) {
	if o.SourceServer != "" && !pgServerNameRE.MatchString(o.SourceServer) {
		return pgClusterState{}, nil, "", fmt.Errorf("--source-server must be an archive server name such as postgresql-20261101t1200")
	}
	if !o.Latest {
		var c pgClusterState
		if err := json.Unmarshal(raw, &c); err != nil {
			return c, nil, "", err
		}
		live, _ := c.pluginServerName()
		if o.SourceServer == "" || o.SourceServer == live {
			c, store, err := validatePGPITR(raw, storeRaw, o.Target, now)
			return c, store, live, err
		}
		if !o.Target.Before(now) {
			return c, nil, "", fmt.Errorf("PITR target must be in the past")
		}
	}
	var c pgClusterState
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, nil, "", err
	}
	live, ok := c.pluginServerName()
	if !ok {
		return c, nil, "", fmt.Errorf("PITR requires WAL archiving (Barman Cloud plugin); run `platformctl install postgresql-backup`")
	}
	store := &pgObjectStoreState{}
	if err := json.Unmarshal(storeRaw, store); err != nil || store.Spec.Configuration.DestinationPath == "" {
		return c, nil, "", fmt.Errorf("ObjectStore %s/%s is missing or unreadable", "databases", PGObjectStoreName)
	}
	source := o.SourceServer
	if source == "" {
		source = live
	}
	return c, store, source, nil
}

// RestorePostgresPITRWith recovers PostgreSQL from the WAL archive.
func RestorePostgresPITRWith(cfg *config.Config, o PITROptions) (err error) {
	if !PostgresUsesCNPG(cfg) {
		return fmt.Errorf("point-in-time recovery needs PostgreSQL on CloudNativePG; this install still runs the Bitnami release. Move it with `sudo platformctl postgres migrate --confirm` first")
	}
	target := o.Target
	if !o.Latest && !target.Before(time.Now()) {
		return fmt.Errorf("PITR target must be in the past")
	}
	raw, err := shell.Output("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql", "-o", "json")
	if err != nil {
		return err
	}
	storeRaw, _ := shell.Output("kubectl", "-n", "databases", "get", "objectstores.barmancloud.cnpg.io", PGObjectStoreName, "--ignore-not-found", "-o", "json")
	_, store, source, err := validatePGRecovery([]byte(raw), []byte(storeRaw), o, time.Now())
	if err != nil {
		return err
	}
	if o.Latest {
		target = time.Time{}
	}
	conf := store.Spec.Configuration
	// Preserve the live destination rather than silently restoring from changed .env settings.
	b := &pgBackup{conf.DestinationPath, conf.EndpointURL, conf.S3Credentials.AccessKeyID.Name, conf.S3Credentials.Region.Key}
	if b.Secret == "" || b.Secret != conf.S3Credentials.SecretAccessKey.Name || conf.S3Credentials.AccessKeyID.Key != "ACCESS_KEY_ID" || conf.S3Credentials.SecretAccessKey.Key != "ACCESS_SECRET_KEY" {
		return fmt.Errorf("PITR requires one backup Secret with ACCESS_KEY_ID and ACCESS_SECRET_KEY")
	}
	server := pgPITRServerName(time.Now())
	opts := pgClusterOptions{Backup: b, ServerName: server, Recovery: &pgRecovery{target, source}}
	if _, err = renderPostgresCluster(cfg, opts); err != nil {
		return err
	}
	resume, err := (backup.HostDriver{}).Quiesce()
	if resume != nil {
		defer func() {
			if e := resume(); e != nil {
				err = errors.Join(err, fmt.Errorf("resume API: %w", e))
			}
		}()
	}
	if err != nil {
		return err
	}
	if err = shell.RunBash(pgPITRWALSwitchScript); err != nil {
		return fmt.Errorf("archive final WAL before PITR: %w", err)
	}
	if err = shell.Run("kubectl", "-n", "databases", "delete", "clusters.postgresql.cnpg.io", "postgresql", "--wait=true", "--timeout=5m"); err != nil {
		return err
	}
	if err = applyPGCluster(cfg, opts); err != nil {
		return err
	}
	if err = shell.RunBash(pgPrimaryReadyScript); err != nil {
		return err
	}
	if err = applyTelemetryJSON(pgAliasService()); err != nil {
		return err
	}
	m := pgResource("Backup", fmt.Sprintf("postgresql-after-pitr-%d", time.Now().Unix()))
	m["spec"] = pgPluginBackupSpec(map[string]any{})
	if err = applyTelemetryJSON(m); err != nil {
		return err
	}
	color.Green("PostgreSQL recovered with serverName %s. A fresh base backup was requested; the daily ScheduledBackup also remains active.", server)
	return nil
}

const pgPITRWALSwitchScript = `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
timeout 2m bash -c '
pod=$(kubectl -n databases get pod -l cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary -o jsonpath={.items[0].metadata.name})
test -n "$pod"
sql() { kubectl -n databases exec "$pod" -c postgres -- psql -U postgres -d postgres -Atc "$1"; }
old=$(sql "SELECT last_archived_wal FROM pg_stat_archiver")
# Recovery to a target time stops only at a commit record after the target. On
# an idle database the last commit can precede it, and recovery then fails
# ("recovery ended before configured recovery target was reached", 3-node
# test): txid_current() assigns a transaction id, so this commit is logged
# with the current time, which is after the (past) target.
sql "SELECT txid_current()"
# CHECKPOINT always writes WAL, so the switch below closes a new segment even when idle.
sql "CHECKPOINT"
sql "SELECT pg_switch_wal()"
until new=$(sql "SELECT last_archived_wal FROM pg_stat_archiver") && [ -n "$new" ] && [ "$new" != "$old" ]; do sleep 2; done
'
`

// pg_primary_pod must be called directly (not in a command substitution), so
// PG_CONTAINER remains available to subsequent kubectl exec calls.
const pgPrimaryPodShell = `pg_primary_pod() {
  PG_POD="$(kubectl -n databases get pod -l cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  export PG_CONTAINER=postgres
  if [[ -z "$PG_POD" ]]; then
    PG_POD="$(kubectl -n databases get pod -l app.kubernetes.io/name=postgresql -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    export PG_CONTAINER=postgresql
  fi
}
`
