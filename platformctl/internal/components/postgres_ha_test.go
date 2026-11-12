package components

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

func TestRenderPostgresCluster(t *testing.T) {
	for _, tc := range []struct {
		name, sc, retention string
		backup, recovery    bool
	}{
		{name: "defaults"}, {name: "custom storage", sc: "fast-ssd"}, {name: "bundled backup", backup: true}, {name: "external backup", backup: true, retention: "4w"}, {name: "recovery", backup: true, recovery: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &config.Config{PostgresHAStorageClass: tc.sc, PostgresBackupRetention: tc.retention, PostgresPassword: "must-not-appear"}
			opts := pgClusterOptions{ServerName: "postgresql-pitr-123"}
			if tc.backup {
				opts.Backup = &pgBackup{"s3://backups/prefix/", "https://s3.example.com", "external-s3"}
				if tc.name == "bundled backup" {
					opts.Backup, _ = pgBackupTarget(cfg)
				}
			}
			if tc.recovery {
				opts.Recovery = &pgRecovery{time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), "postgresql"}
			}
			m, err := renderPostgresCluster(cfg, opts)
			if err != nil {
				t.Fatal(err)
			}
			spec := m["spec"].(map[string]any)
			if m["kind"] != "Cluster" || m["metadata"].(map[string]any)["name"] != "postgresql" || spec["instances"] != 3 || spec["imageName"] != versions.CNPGPostgresImage {
				t.Fatal(m)
			}
			sc := tc.sc
			if sc == "" {
				sc = "local-path"
			}
			if spec["storage"].(map[string]string)["storageClass"] != sc {
				t.Fatal(spec["storage"])
			}
			if spec["affinity"].(map[string]any)["podAntiAffinityType"] != "required" {
				t.Fatal(spec["affinity"])
			}
			pg := spec["postgresql"].(map[string]any)
			if !reflect.DeepEqual(pg["synchronous"], map[string]any{"method": "any", "number": 1, "dataDurability": "preferred"}) || !reflect.DeepEqual(pg["shared_preload_libraries"], []string{"pgaudit", "pg_stat_statements"}) {
				t.Fatal(pg)
			}
			if spec["superuserSecret"].(map[string]string)["name"] != "postgresql" || spec["enableSuperuserAccess"] != true || spec["enablePDB"] != true || spec["primaryUpdateMethod"] != "switchover" || spec["smartShutdownTimeout"] != 15 {
				t.Fatal(spec)
			}
			if _, ok := spec["backup"]; ok != tc.backup {
				t.Fatal(spec)
			}
			if tc.backup {
				b := spec["backup"].(map[string]any)
				ret := tc.retention
				if ret == "" {
					ret = "14d"
				}
				if b["retentionPolicy"] != ret {
					t.Fatal(b)
				}
				store := b["barmanObjectStore"].(map[string]any)
				if store["serverName"] != opts.ServerName || store["destinationPath"] != opts.Backup.Destination || store["endpointURL"] != opts.Backup.Endpoint {
					t.Fatal(store)
				}
				if !reflect.DeepEqual(store["wal"], map[string]any{"compression": "gzip", "maxParallel": 2}) {
					t.Fatal(store)
				}
			}
			if tc.recovery {
				if _, ok := spec["bootstrap"].(map[string]any)["initdb"]; ok {
					t.Fatal("initdb in recovery")
				}
				ext := spec["externalClusters"].([]any)[0].(map[string]any)
				if ext["barmanObjectStore"].(map[string]any)["serverName"] != "postgresql" {
					t.Fatal(ext)
				}
			}
			raw, _ := json.Marshal(m)
			if strings.Contains(string(raw), cfg.PostgresPassword) {
				t.Fatal("password leaked")
			}
		})
	}
	m, err := renderPostgresCluster(&config.Config{}, pgClusterOptions{Backup: &pgBackup{"s3://backups/", "", "s3"}})
	if err != nil {
		t.Fatal(err)
	}
	store := m["spec"].(map[string]any)["backup"].(map[string]any)["barmanObjectStore"].(map[string]any)
	if _, ok := store["endpointURL"]; ok || store["serverName"] != "postgresql" {
		t.Fatal(store)
	}
	if _, err := renderPostgresCluster(&config.Config{}, pgClusterOptions{Recovery: &pgRecovery{}}); err == nil {
		t.Fatal("recovery without backup")
	}
}

func TestPGBackupTarget(t *testing.T) {
	for _, tc := range []struct {
		name string
		cfg  config.Config
		want string
	}{
		{"defaults", config.Config{}, ""},
		{"external", config.Config{PostgresBackupDestination: "s3://my-bucket/db/", PostgresBackupSecret: "s3-creds"}, ""},
		{"bad destination", config.Config{PostgresBackupDestination: "s3://x/", PostgresBackupSecret: "s3"}, "DESTINATION"},
		{"missing secret", config.Config{PostgresBackupDestination: "s3://backups/"}, "SECRET"},
		{"bad retention", config.Config{PostgresBackupRetention: "0d"}, "RETENTION"},
		{"bad endpoint", config.Config{PostgresBackupEndpoint: "https://example.com\n"}, "ENDPOINT"},
		{"bad secret", config.Config{PostgresBackupSecret: "Bad_Secret"}, "SECRET"},
		{"bad storage", config.Config{PostgresHAStorageClass: "bad_name"}, "STORAGE_CLASS"},
		{"long label", config.Config{PostgresHAStorageClass: strings.Repeat("a", 64)}, "STORAGE_CLASS"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := pgBackupTarget(&tc.cfg)
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("%v", err)
				}
			} else if err != nil || b == nil {
				t.Fatal(b, err)
			}
		})
	}
}

func TestPGServiceAndQueries(t *testing.T) {
	svc := pgAliasService()
	labels := svc["metadata"].(map[string]any)["labels"].(map[string]string)
	if _, ok := labels["app.kubernetes.io/name"]; ok {
		t.Fatal(labels)
	}
	if !reflect.DeepEqual(svc["spec"].(map[string]any)["selector"], map[string]string{"cnpg.io/cluster": "postgresql", "cnpg.io/instanceRole": "primary"}) {
		t.Fatal(svc)
	}
	cm := pgMonitoringConfigMap()
	q := cm["data"].(map[string]string)["queries"]
	for _, s := range []string{"project_database:", "primary: true", "datname LIKE 'plat_%'", "usage: LABEL", "usage: GAUGE"} {
		if !strings.Contains(q, s) {
			t.Fatal(q)
		}
	}
}

func TestWritePostgresHAStatus(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      []string
	}{
		{"healthy", `{"spec":{"instances":3,"backup":{"barmanObjectStore":{}}},"status":{"phase":"Cluster in healthy state","readyInstances":3,"currentPrimary":"postgresql-2","lastSuccessfulBackup":"backup-time","firstRecoverabilityPoint":"first-time","conditions":[{"type":"ContinuousArchiving","status":"True"}]}}`, []string{"3/3 ready, primary postgresql-2", "WAL archiving: ok", "backup-time", "first-time"}},
		{"degraded", `{"spec":{"instances":3},"status":{"readyInstances":1}}`, []string{"1/3 ready", "WARNING", "not configured"}},
		{"archive failed", `{"spec":{"backup":{"barmanObjectStore":{}}},"status":{"conditions":[{"type":"ContinuousArchiving","status":"False"}]}}`, []string{"WAL archiving: FAILING"}},
		{"missing fields", `{}`, []string{"0/0 ready", "not configured"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var b bytes.Buffer
			if err := writePostgresHAStatus(&b, []byte(tc.raw)); err != nil {
				t.Fatal(err)
			}
			for _, s := range tc.want {
				if !strings.Contains(b.String(), s) {
					t.Fatal(b.String())
				}
			}
			if !strings.Contains(b.String(), "postgresql-ro.databases:5432") {
				t.Fatal(b.String())
			}
		})
	}
	if err := writePostgresHAStatus(&bytes.Buffer{}, []byte("bad")); err == nil {
		t.Fatal("invalid JSON accepted")
	}
}

func TestPGPITRValidation(t *testing.T) {
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	raw := []byte(`{"spec":{"backup":{"barmanObjectStore":{"serverName":"postgresql"}}},"status":{"firstRecoverabilityPoint":"2026-11-10T10:00:00Z"}}`)
	for _, tc := range []struct {
		target time.Time
		fail   bool
	}{{now.Add(time.Hour), true}, {now, true}, {now.Add(-72 * time.Hour), true}, {now.Add(-time.Hour), false}, {now.Add(-48 * time.Hour), false}} {
		_, err := validatePGPITR(raw, tc.target, now)
		if (err != nil) != tc.fail {
			t.Fatal(tc, err)
		}
	}
	for _, raw := range []string{`{}`, `{"spec":{"backup":{"barmanObjectStore":{}}}}`, `bad`} {
		if _, err := validatePGPITR([]byte(raw), now.Add(-time.Hour), now); err == nil {
			t.Fatal(raw)
		}
	}
	if got := pgPITRServerName(now); got != fmt.Sprintf("postgresql-pitr-%d", now.Unix()) {
		t.Fatal(got)
	}
}

func TestPGScripts(t *testing.T) {
	for _, script := range []string{pgPrimaryReadyScript, pgPITRWALSwitchScript, pgPrimaryPodShell, cnpgHelmScript("/tmp/values ' file.yaml")} {
		if strings.Contains(script, "\r") {
			t.Fatal("CR in embedded shell")
		}
	}
	s := cnpgHelmScript("/tmp/values ' file.yaml")
	for _, v := range []string{"clear_helm_lock cnpg cnpg-system", "--timeout 10m", "rollout status deploy/cnpg-cloudnative-pg", "condition=Established", shellQuote("/tmp/values ' file.yaml")} {
		if !strings.Contains(s, v) {
			t.Fatal(s)
		}
	}
	s = minioBucketUserScript("postgres-backups", "postgres-backup", "S3_ACCESS_KEY", "S3_SECRET_KEY")
	if strings.Contains(s, "telemetry-postgres") || !strings.Contains(s, "arn:aws:s3:::postgres-backups/*") {
		t.Fatal(s)
	}
	if !strings.Contains(minioJobWaitScript("databases", "backup-job", 20), "kubectl -n databases") {
		t.Fatal("namespace missing")
	}
}

func TestPGPrimaryPodSelection(t *testing.T) {
	for _, cnpg := range []bool{false, true} {
		primary := ""
		wantPod, wantContainer := "postgresql-0", "postgresql"
		if cnpg {
			primary = "postgresql-2"
			wantPod, wantContainer = primary, "postgres"
		}
		script := `kubectl() {
  if [[ "$*" == *cnpg.io/instanceRole=primary* ]]; then printf '%s' ` + shellQuote(primary) + `; else printf postgresql-0; fi
}
` + pgPrimaryPodShell + "\npg_primary_pod\n[[ $PG_POD == " + shellQuote(wantPod) + " && $PG_CONTAINER == " + shellQuote(wantContainer) + " ]]\n"
		if out, err := runJobShell(t, script); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
}

func TestCNPGRecoveryPatchesSecretWithoutTrust(t *testing.T) {
	start := strings.Index(recoverScript, `if [[ -z "$WORKING" && "$PG_CONTAINER" == postgres ]]`)
	if start < 0 {
		t.Fatal("CNPG recovery branch absent")
	}
	end := strings.Index(recoverScript[start:], "if [[ -z \"$WORKING\" ]]; then") + start
	if start < 0 || end <= start {
		t.Fatal("CNPG recovery branch absent")
	}
	for _, works := range []bool{false, true} {
		result := "return 1"
		if works {
			result = `[[ $1 == target && $2 == postgres ]]`
		}
		script := `set -euo pipefail
WORKING=""; PG_CONTAINER=postgres; PG_TARGET=target
b64() { printf dGFyZ2V0; }
kubectl() {
  [[ "$*" == *'patch secret postgresql --type merge --patch-file=/dev/stdin'* ]] || return 91
  local patch; patch=$(cat)
  [[ "$patch" == '{"data":{"password":"dGFyZ2V0","postgres-password":"dGFyZ2V0"}}' ]]
}

sleep() { :; }
persist_pg_now() { [[ $1 == target ]]; }
psql_with_pw() { ` + result + `; }
` + recoverScript[start:end] + `[[ "$WORKING" == target ]]`
		out, err := runJobShell(t, script)
		if (err == nil) != works {
			t.Fatalf("works=%v: %v %s", works, err, out)
		}
		if !works && !strings.Contains(out, "CNPG did not apply") {
			t.Fatal(out)
		}
	}
}

// Digests from the pre-refactor scripts protect non-HA telemetry behavior,
// including the replay lifecycle policy, while PostgreSQL reuses the helpers.
func TestTelemetryMinioScriptsRemainByteIdentical(t *testing.T) {
	for name, want := range map[string]string{
		"loki":      "7a2d9ac2fcd80345150592c4bbb0cf305956f1e1e98c668dd2f3db3520ed9373",
		"tempo":     "88e8761fb1352f4239a7feed67dc4189f806c8e0dedb9be439e93de8790d1a1d",
		"pyroscope": "5bcc93c501ba47b62a6f926886b49141a7c6d012f31cb50c877a048e5850f4a9",
		"replays":   "add2b5462d32ec6640223aae4f1e3544f7a5682981fe115b3cbb2cfa10f300db",
	} {
		if got := fmt.Sprintf("%x", sha256.Sum256([]byte(telemetryBucketScript(name)))); got != want {
			t.Fatalf("%s: %s", name, got)
		}
	}
	if got := fmt.Sprintf("%x", sha256.Sum256([]byte(telemetryJobWaitScript("telemetry-storage-loki", 930)))); got != "2163fb435618201bb95d32463d01b42e121d06094561022bc589e833cd6c74c8" {
		t.Fatal(got)
	}
}
