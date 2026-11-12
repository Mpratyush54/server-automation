package components

import (
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"testing"
)

func TestDatabaseMonitoringProfile(t *testing.T) {
	for _, profile := range []string{"minimal", "standard", "full", "ha", ""} {
		c := &config.Config{Profile: profile, InstallMonitoring: true}
		for _, engine := range []string{"postgres", "mongo", "redis"} {
			v := databaseMonitoringValues(c, engine, map[string]string{"password": "test"})
			m := v["metrics"].(map[string]any)
			if m["enabled"] != (profile == "full" || profile == "ha") {
				t.Fatalf("unexpected monitoring for %s", profile)
			}
			if (profile == "full" || profile == "ha") && m["resources"] == nil {
				t.Fatal("missing resource bounds")
			}
			if engine == "mongo" {
				if us, _ := v["updateStrategy"].(map[string]any); us["type"] != "Recreate" {
					t.Fatalf("mongo must use the Recreate strategy (%s)", profile)
				}
			}
			if profile != "full" && profile != "ha" && v["postgresqlSharedPreloadLibraries"] != nil {
				t.Fatal("preload on light profile")
			}
		}
	}
}
