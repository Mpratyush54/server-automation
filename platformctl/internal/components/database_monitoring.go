package components

import "github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"

// Sidecars stay disabled for all lighter profiles; do not create ServiceMonitors
// during the database graph steps (Prometheus CRDs are installed later).
func databaseMonitoringValues(c *config.Config, engine string, auth map[string]string) map[string]any {
	v := map[string]any{"auth": auth}
	if engine == "mongo" {
		// Standalone MongoDB is a Deployment on one RWO volume: a rolling update starts
		// the new pod while the old one holds mongod.lock (DBPathInUse) and every Helm
		// upgrade that changes the pod (e.g. enabling the exporter) never completes.
		v["updateStrategy"] = map[string]any{"type": "Recreate"}
	}
	metrics := map[string]any{"enabled": FullTelemetry(c)}
	v["metrics"] = metrics
	if !FullTelemetry(c) {
		return v
	}
	metrics["resources"] = map[string]any{
		"requests": map[string]string{"cpu": "10m", "memory": "32Mi"},
		"limits":   map[string]string{"cpu": "100m", "memory": "96Mi"},
	}
	metrics["service"] = map[string]any{"annotations": map[string]string{"prometheus.io/scrape": "true"}}
	if engine == "postgres" {
		v["postgresqlSharedPreloadLibraries"] = "pgaudit,pg_stat_statements"
		metrics["customMetrics"] = map[string]any{"project_database": map[string]any{
			"query": "SELECT datname, numbackends AS connections, pg_database_size(datname) AS size_bytes FROM pg_stat_database WHERE datname LIKE 'plat_%'",
			"metrics": []any{
				map[string]any{"datname": map[string]string{"usage": "LABEL", "description": "Database"}},
				map[string]any{"connections": map[string]string{"usage": "GAUGE", "description": "Database connections"}},
				map[string]any{"size_bytes": map[string]string{"usage": "GAUGE", "description": "Database bytes"}},
			},
		}}
	}
	return v
}
