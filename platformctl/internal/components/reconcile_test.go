package components

import (
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func helmCalls(calls []toolCall) int {
	n := 0
	for _, c := range calls {
		if c.Tool == "helm" {
			n++
		}
	}
	return n
}

// Regression: re-running provision after an upgrade skipped the databases
// because of their done markers, so new values (metrics exporters) never
// reached existing installs.
func TestDatabaseReleasesReconcileWhenValuesChange(t *testing.T) {
	calls := fakeTools(t)
	cfg := &config.Config{PostgresPassword: "p", MongoPassword: "m", RedisPassword: "r"}
	if err := InstallPostgreSQL(cfg); err != nil {
		t.Fatal(err)
	}
	if helmCalls(calls()) != 1 || postgresqlRelease(cfg).Status() != StatusCurrent {
		t.Fatal("first install not recorded with its fingerprint")
	}
	if err := InstallPostgreSQL(cfg); err != nil || helmCalls(calls()) != 1 {
		t.Fatal("unchanged values re-ran helm", err)
	}
	// A done marker from a release without fingerprints (v1.2.0) reconciles once.
	if err := state.Set("postgresql.values", "from-an-older-release"); err != nil {
		t.Fatal(err)
	}
	if postgresqlRelease(cfg).Status() != StatusReconcile {
		t.Fatal("changed values not detected")
	}
	if err := InstallPostgreSQL(cfg); err != nil || helmCalls(calls()) != 2 {
		t.Fatal("changed values did not run helm upgrade", err)
	}
	if postgresqlRelease(cfg).Status() != StatusCurrent {
		t.Fatal("fingerprint not updated")
	}
}

func TestFingerprintIgnoresCredentialsButTracksConfiguration(t *testing.T) {
	a := redisRelease(&config.Config{RedisPassword: "one"})
	b := redisRelease(&config.Config{RedisPassword: "two"})
	if a.Fingerprint() != b.Fingerprint() {
		t.Fatal("fingerprint derives from the password")
	}
	b.Values["metrics"] = map[string]any{"enabled": true}
	if a.Fingerprint() == b.Fingerprint() {
		t.Fatal("values change not reflected")
	}
	c := redisRelease(&config.Config{})
	c.Args = append(c.Args, "--set", "x=y")
	if a.Fingerprint() == c.Fingerprint() {
		t.Fatal("argument change not reflected")
	}
}
