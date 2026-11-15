package components

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

type applied struct{ kind, ns, name string }

// stubKube captures kubectl apply payloads and serves Secrets from memory.
func stubKube(t *testing.T, secrets map[string]map[string]string) *[]map[string]any {
	t.Helper()
	var out []map[string]any
	oldApply, oldSecret, oldNS, oldDir := kubeApplyJSON, kubeSecret, kubeNamespaceExists, backup.MetricsDir
	backup.MetricsDir = t.TempDir()
	kubeApplyJSON = func(v any) error {
		b, _ := json.Marshal(v)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		out = append(out, m)
		return nil
	}
	kubeSecret = func(ns, name string) (map[string]string, error) {
		if s, ok := secrets[ns+"/"+name]; ok {
			return s, nil
		}
		return nil, errors.New("not found")
	}
	kubeNamespaceExists = func(string) bool { return false }
	t.Cleanup(func() {
		kubeApplyJSON, kubeSecret, kubeNamespaceExists, backup.MetricsDir = oldApply, oldSecret, oldNS, oldDir
	})
	return &out
}

func objects(list []map[string]any) []applied {
	var out []applied
	for _, m := range list {
		md, _ := m["metadata"].(map[string]any)
		ns, _ := md["namespace"].(string)
		name, _ := md["name"].(string)
		out = append(out, applied{m["kind"].(string), ns, name})
	}
	return out
}

func externalCfg(profile string) *config.Config {
	return &config.Config{Profile: profile, Backup: config.BackupSettings{Mode: config.BackupModeExternal, Endpoint: "https://s3.example.net", Bucket: "cairn-bk", Region: "eu-1", Prefix: "srv-a", AccessKey: "AKEXAMPLE", SecretKey: "SECRET-VALUE"}}
}

func TestApplyBackupTargetWritesSecretsPerConsumer(t *testing.T) {
	for _, profile := range []string{config.ProfileStandard, config.ProfileHA} {
		t.Run(profile, func(t *testing.T) {
			got := stubKube(t, nil)
			cfg := externalCfg(profile)
			if err := ApplyBackupTarget(cfg, BackupTargetFromConfig(cfg)); err != nil {
				t.Fatal(err)
			}
			want := []applied{{"Secret", "platform", backup.TargetSecret}, {"Secret", "databases", backup.PostgresTargetSecret}, {"ConfigMap", "platform", backup.TargetConfigMap}}
			if profile == config.ProfileHA {
				want = []applied{{"Namespace", "", LonghornNamespace}, {"Secret", "platform", backup.TargetSecret}, {"Secret", "databases", backup.PostgresTargetSecret}, {"Secret", "kube-system", backup.EtcdTargetSecret}, {"Secret", LonghornNamespace, backup.LonghornTargetSecret}, {"ConfigMap", "platform", backup.TargetConfigMap}}
			}
			if gotObjs := objects(*got); len(gotObjs) != len(want) {
				t.Fatal(gotObjs)
			} else {
				for i := range want {
					if gotObjs[i] != want[i] {
						t.Fatal(gotObjs)
					}
				}
			}
			for _, m := range *got {
				raw, _ := json.Marshal(m)
				hasSecret := strings.Contains(string(raw), "SECRET-VALUE")
				if (m["kind"] == "Secret") != hasSecret {
					t.Fatalf("credentials must be in Secrets only: %s", raw)
				}
			}
			cm := (*got)[len(*got)-1]["data"].(map[string]any)
			if cm["mode"] != "external" || cm["endpointHost"] != "s3.example.net" || cm["bucket"] != "cairn-bk" || cm["prefix"] != "srv-a" {
				t.Fatal(cm)
			}
			metric, _ := os.ReadFile(filepath.Join(backup.MetricsDir, "platform_backup_target.prom"))
			if !strings.Contains(string(metric), "platform_backup_target_external 1") {
				t.Fatal(string(metric))
			}
		})
	}
}

func TestEnsureBackupTarget(t *testing.T) {
	// Credentials given this run are stored.
	got := stubKube(t, nil)
	if err := EnsureBackupTarget(externalCfg(config.ProfileStandard)); err != nil || len(*got) != 3 {
		t.Fatal(err, objects(*got))
	}
	// Re-run without credentials: the stored Secret is reused.
	cfg := externalCfg(config.ProfileStandard)
	stored := BackupTargetFromConfig(cfg).SecretData()
	cfg.Backup.AccessKey, cfg.Backup.SecretKey = "", ""
	got = stubKube(t, map[string]map[string]string{"platform/" + backup.TargetSecret: stored})
	if err := EnsureBackupTarget(cfg); err != nil {
		t.Fatal(err)
	}
	if o := objects(*got); len(o) != 1 || o[0].kind != "ConfigMap" {
		t.Fatal(o)
	}
	// A changed bucket in .env is re-applied with the stored credentials.
	cfg.Backup.Bucket = "moved-bucket"
	got = stubKube(t, map[string]map[string]string{"platform/" + backup.TargetSecret: stored})
	if err := EnsureBackupTarget(cfg); err != nil || len(*got) != 3 {
		t.Fatal(err, objects(*got))
	}
	if d := (*got)[0]["stringData"].(map[string]any); d["bucket"] != "moved-bucket" || d["secret-key"] != "SECRET-VALUE" {
		t.Fatal(d)
	}
	// Missing credentials and no stored Secret: a plain error.
	got = stubKube(t, nil)
	if err := EnsureBackupTarget(cfg); err == nil || !strings.Contains(err.Error(), "BACKUP_S3_ACCESS_KEY") {
		t.Fatal(err)
	}
	// Local only: summary + metric 0.
	got = stubKube(t, nil)
	if err := EnsureBackupTarget(&config.Config{Backup: config.BackupSettings{Mode: config.BackupModeLocal}}); err != nil {
		t.Fatal(err)
	}
	if (*got)[0]["data"].(map[string]any)["mode"] != "local" {
		t.Fatal(*got)
	}
	metric, _ := os.ReadFile(filepath.Join(backup.MetricsDir, "platform_backup_target.prom"))
	if !strings.Contains(string(metric), "platform_backup_target_external 0") {
		t.Fatal(string(metric))
	}
}

func TestPrintBackupTargetStatus(t *testing.T) {
	stubKube(t, nil)
	var b bytes.Buffer
	PrintBackupTargetStatus(&b, &config.Config{})
	if !strings.Contains(b.String(), "Backups are stored only on this server") {
		t.Fatal(b.String())
	}
	b.Reset()
	PrintBackupTargetStatus(&b, externalCfg(config.ProfileStandard))
	if !strings.Contains(b.String(), "off-site target s3.example.net/cairn-bk/srv-a") || !strings.Contains(b.String(), "Secret platform/platform-backup-target is missing") || strings.Contains(b.String(), "SECRET-VALUE") {
		t.Fatal(b.String())
	}
}

func TestProbeBackupTargetValidatesFirst(t *testing.T) {
	old := probeTarget
	defer func() { probeTarget = old }()
	called := false
	probeTarget = func(backup.S3Target) error { called = true; return nil }
	if err := ProbeBackupTarget(backup.S3Target{Bucket: "ok-bucket"}); err == nil || called {
		t.Fatal("missing credentials must fail before any request")
	}
	if err := ProbeBackupTarget(BackupTargetFromConfig(externalCfg(""))); err != nil || !called {
		t.Fatal(err)
	}
}

func TestExternalTargetFeedsPostgresLonghornAndEtcd(t *testing.T) {
	cfg := externalCfg(config.ProfileHA)
	b, err := pgBackupTarget(cfg)
	if err != nil || b.Destination != "s3://cairn-bk/srv-a/postgres/" || b.Endpoint != "https://s3.example.net" || b.Secret != backup.PostgresTargetSecret || b.RegionKey != "REGION" {
		t.Fatal(b, err)
	}
	creds := pgObjectStoreResource(cfg, b)["spec"].(map[string]any)["configuration"].(map[string]any)["s3Credentials"].(map[string]any)
	if creds["region"].(map[string]string)["key"] != "REGION" {
		t.Fatal(creds)
	}
	// An explicit POSTGRES_BACKUP_DESTINATION still wins.
	legacy := externalCfg(config.ProfileHA)
	legacy.PostgresBackupDestination, legacy.PostgresBackupSecret = "s3://other-bucket/db/", "s3-creds"
	if b, _ := pgBackupTarget(legacy); b.Destination != "s3://other-bucket/db/" {
		t.Fatal(b)
	}
	values, err := renderLonghornValues(cfg, 3)
	if err != nil || !strings.Contains(values, `backupTarget: "s3://cairn-bk@eu-1/srv-a/longhorn"`) || !strings.Contains(values, `backupTargetCredentialSecret: "platform-longhorn-backup"`) {
		t.Fatal(values, err)
	}
	res := longhornBackupResources(longhornBackupStore(cfg))
	if res[0]["kind"] != "BackupTarget" || res[1]["spec"].(map[string]any)["task"] != "backup" {
		t.Fatal(res)
	}
	single := externalCfg(config.ProfileStandard)
	if target, _ := longhornBackupStore(single); target != "" {
		t.Fatal("no Longhorn on single-node profiles")
	}
	local := &config.Config{Profile: config.ProfileHA}
	if b, _ := pgBackupTarget(local); b.Destination != "s3://postgres-backups/" {
		t.Fatal(b)
	}
}

func TestSingleNodePostgresCluster(t *testing.T) {
	cfg := &config.Config{Profile: config.ProfileStandard}
	m, err := renderPostgresCluster(cfg, pgClusterOptions{ServerName: "postgresql-20261115t1200", Backup: &pgBackup{"s3://b/p/postgres/", "", "s", "REGION"}})
	if err != nil {
		t.Fatal(err)
	}
	spec := m["spec"].(map[string]any)
	pg := spec["postgresql"].(map[string]any)
	if spec["instances"] != 1 || spec["enablePDB"] != false || pg["synchronous"] != nil || pg["parameters"].(map[string]string)["archive_timeout"] != "5min" {
		t.Fatal(spec)
	}
	if m["metadata"].(map[string]any)["annotations"].(map[string]string)[pgServerNameAnnotation] != "postgresql-20261115t1200" {
		t.Fatal(m["metadata"])
	}
	// Recovery to the end of the archive has no recoveryTarget.
	m, _ = renderPostgresCluster(cfg, pgClusterOptions{Backup: &pgBackup{"s3://b/", "", "s", ""}, Recovery: &pgRecovery{ServerName: "old"}})
	rec := m["spec"].(map[string]any)["bootstrap"].(map[string]any)["recovery"].(map[string]any)
	if _, ok := rec["recoveryTarget"]; ok {
		t.Fatal(rec)
	}
	if ha, _ := renderPostgresCluster(&config.Config{Profile: config.ProfileHA}, pgClusterOptions{}); ha["spec"].(map[string]any)["instances"] != 3 {
		t.Fatal("ha keeps three instances")
	}
	if !strings.Contains(cnpgValues(cfg), "replicaCount: 1") || !strings.Contains(cnpgValues(&config.Config{Profile: config.ProfileHA}), "replicaCount: 2") {
		t.Fatal("operator replicas")
	}
}

func TestPostgresEngineSelection(t *testing.T) {
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	defer state.SetPath(state.DefaultPath)
	fresh := &config.Config{Profile: config.ProfileMinimal}
	if !PostgresUsesCNPG(fresh) || ResolvePostgresEngine(fresh) != config.PostgresEngineCNPG {
		t.Fatal("fresh single-node installs use CloudNativePG")
	}
	for _, r := range DatabaseReleases(fresh) {
		if r.Step == "postgresql" {
			t.Fatal("no Bitnami release on CNPG installs")
		}
	}
	if err := state.MarkDone("postgresql"); err != nil {
		t.Fatal(err)
	}
	legacy := &config.Config{Profile: config.ProfileStandard}
	if PostgresUsesCNPG(legacy) || ResolvePostgresEngine(legacy) != config.PostgresEngineBitnami {
		t.Fatal("installs from before #186 keep Bitnami until migrated")
	}
	if DatabaseReleases(legacy)[0].Step != "postgresql" {
		t.Fatal("Bitnami release still reconciled")
	}
	migrated := &config.Config{Profile: config.ProfileStandard, PostgresEngine: config.PostgresEngineCNPG}
	if !PostgresUsesCNPG(migrated) || !PostgresUsesCNPG(&config.Config{Profile: config.ProfileHA, PostgresEngine: config.PostgresEngineBitnami}) {
		t.Fatal("recorded engine / ha")
	}
}

func TestPGServerNameFromJSON(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 30, 0, 0, time.UTC)
	for raw, want := range map[string]string{
		``: "postgresql-20261115t1230",
		`{"spec":{"plugins":[{"name":"barman-cloud.cloudnative-pg.io","isWALArchiver":true,"parameters":{"serverName":"pg-a"}}]}}`: "pg-a",
		`{"spec":{"backup":{"barmanObjectStore":{"serverName":"intree"}}}}`:                                                        "intree",
		`{"metadata":{"annotations":{"platform.io/backup-server-name":"annotated"}},"spec":{}}`:                                    "annotated",
		`{"spec":{}}`: "postgresql",
	} {
		if got := pgServerNameFromJSON(raw, now); got != want {
			t.Fatalf("%s: got %s want %s", raw, got, want)
		}
	}
}

func TestValidatePGRecoveryLatestAndSourceServer(t *testing.T) {
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	raw := []byte(`{"spec":{"plugins":[{"name":"barman-cloud.cloudnative-pg.io","isWALArchiver":true,"parameters":{"serverName":"postgresql-new"}}]}}`)
	store := []byte(`{"spec":{"configuration":{"destinationPath":"s3://b/p/postgres/"}},"status":{"serverRecoveryWindow":{"postgresql-new":{"firstRecoverabilityPoint":"2026-11-12T09:00:00Z"}}}}`)
	if _, _, src, err := validatePGRecovery(raw, store, PITROptions{Latest: true}, now); err != nil || src != "postgresql-new" {
		t.Fatal(src, err)
	}
	// Another server's archive: the window is checked by the operator.
	if _, _, src, err := validatePGRecovery(raw, store, PITROptions{Target: now.Add(-48 * time.Hour), SourceServer: "postgresql-old"}, now); err != nil || src != "postgresql-old" {
		t.Fatal(src, err)
	}
	// The live archive still enforces the recovery window.
	if _, _, _, err := validatePGRecovery(raw, store, PITROptions{Target: now.Add(-48 * time.Hour)}, now); err == nil {
		t.Fatal("before firstRecoverabilityPoint")
	}
	if _, _, _, err := validatePGRecovery(raw, store, PITROptions{Latest: true, SourceServer: "Bad Name"}, now); err == nil {
		t.Fatal("invalid server name")
	}
	if _, _, _, err := validatePGRecovery([]byte(`{}`), store, PITROptions{Latest: true}, now); err == nil {
		t.Fatal("no archiving")
	}
}

func TestEnsureEtcdS3DropIn(t *testing.T) {
	old := K3sConfigDir
	K3sConfigDir = t.TempDir()
	defer func() { K3sConfigDir = old }()
	if err := os.WriteFile(filepath.Join(K3sConfigDir, "config.yaml"), []byte("cluster-init: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ensureEtcdS3DropIn(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(K3sConfigDir, "config.yaml.d", "60-platform-etcd-s3.yaml"))
	if err != nil || !strings.Contains(string(b), `etcd-s3-config-secret: "platform-etcd-s3"`) || strings.Contains(string(b), "secret-key") {
		t.Fatal(string(b), err)
	}
	// Configured in config.yaml already (fresh ha installs): no drop-in.
	K3sConfigDir = t.TempDir()
	_ = os.WriteFile(filepath.Join(K3sConfigDir, "config.yaml"), []byte("etcd-s3: true\n"), 0600)
	if err := ensureEtcdS3DropIn(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(K3sConfigDir, "config.yaml.d")); !os.IsNotExist(err) {
		t.Fatal("unexpected drop-in")
	}
}

func TestBackupAlertRules(t *testing.T) {
	for _, want := range []string{"PlatformBackupLocalOnly", "platform_backup_target_external == 0", "PlatformPostgresWALArchivingFailing", "PlatformPostgresWALArchiveStale", "PlatformPostgresBaseBackupStale"} {
		if !strings.Contains(backup.AlertsYAML, want) {
			t.Fatal(want)
		}
	}
}
