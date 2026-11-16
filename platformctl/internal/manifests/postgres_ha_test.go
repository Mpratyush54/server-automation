package manifests

import (
	"strings"
	"testing"
)

func TestPostgresHAManifests(t *testing.T) {
	for _, name := range []string{"cnpg-values.yaml", "postgresql-ha-monitoring.yaml"} {
		b, err := Read(name)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "\r") {
			t.Fatal("CR in " + name)
		}
	}
	b, _ := Read("postgresql-ha-monitoring.yaml")
	for _, s := range []string{"kind: PodMonitor", "release: kube-prometheus", "cnpg_collector_up", "replacement: pg_up", "replacement: project_database_$1", "PostgresHAInstanceDown", "PostgresHANoPrimary", "PostgresHAReplicationLag", "PostgresHAWALArchivingFailing", "PostgresHABackupTooOld", "cnpg_pg_replication_in_recovery"} {
		if !strings.Contains(string(b), s) {
			t.Fatal("missing " + s)
		}
	}
}
