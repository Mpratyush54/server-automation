package config

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPostgresReplicationLoadAndValidate(t *testing.T) {
	t.Setenv("POSTGRES_REPLICATION", "")
	c := Load()
	if c.PostgresReplication != PostgresReplicationSync || c.PostgresReplicationChosen() {
		t.Fatalf("default = %q chosen=%v", c.PostgresReplication, c.PostgresReplicationChosen())
	}
	t.Setenv("POSTGRES_REPLICATION", " ASYNC ")
	c = Load()
	if c.PostgresReplication != PostgresReplicationAsync || !c.PostgresReplicationChosen() || c.ValidatePostgresReplication() != nil {
		t.Fatalf("override = %q chosen=%v", c.PostgresReplication, c.PostgresReplicationChosen())
	}
	for _, ok := range []string{"", "sync", "async", "Sync", " async\t"} {
		if err := ValidatePostgresReplicationMode(ok); err != nil {
			t.Errorf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"preferred", "synchronous", "quorum", "sync\nX=1"} {
		err := ValidatePostgresReplicationMode(bad)
		if err == nil || !strings.Contains(err.Error(), PostgresReplicationDocsURL) {
			t.Errorf("%q accepted or no docs link: %v", bad, err)
		}
	}
}

func TestPostgresReplicationSavedOnHAOnly(t *testing.T) {
	t.Setenv("POSTGRES_REPLICATION", "")
	p := filepath.Join(t.TempDir(), ".env")
	c := Load()
	c.Profile = ProfileHA
	c.PostgresReplication = PostgresReplicationAsync
	if err := c.SaveEnvFile(p); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if !strings.Contains(string(b), "\nPOSTGRES_REPLICATION=async\n") {
		t.Fatal("ha .env misses POSTGRES_REPLICATION=async")
	}
	c.PostgresReplication = ""
	if err := c.SaveEnvFile(p); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(p)
	if !strings.Contains(string(b), "\nPOSTGRES_REPLICATION=sync\n") {
		t.Fatal("empty mode not saved as sync")
	}
	c.PostgresReplication = "maybe"
	if err := c.SaveEnvFile(p); err == nil {
		t.Fatal("invalid mode saved")
	}
	c.Profile = ProfileStandard
	if err := c.SaveEnvFile(p); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(p)
	if strings.Contains(string(b), "POSTGRES_REPLICATION") {
		t.Fatal("POSTGRES_REPLICATION written on a single-server profile")
	}
}

func TestPromptPostgresReplication(t *testing.T) {
	for _, tc := range []struct{ start, input, want string }{
		{"sync", "\n", "sync"},
		{"async", "\n", "async"},
		{"sync", "async\n", "async"},
		{"async", " SYNC \r\n", "sync"},
		{"sync", "fast\nasync\n", "async"},
		{"sync", "x\ny\nz\nasync\n", "sync"}, // three wrong answers keep the current value
		{"", "", "sync"},                     // EOF
	} {
		c := &Config{PostgresReplication: tc.start}
		var out bytes.Buffer
		in := strings.NewReader(tc.input + "rest-for-next-prompt\n")
		c.PromptPostgresReplication(in, &out)
		if c.PostgresReplication != tc.want {
			t.Errorf("start %q input %q: got %q", tc.start, tc.input, c.PostgresReplication)
		}
		if !strings.Contains(out.String(), PostgresReplicationDocsURL) || !strings.Contains(out.String(), "async") {
			t.Errorf("prompt text misses the choices or docs link:\n%s", out.String())
		}
		if tc.input == "\n" || tc.input == "async\n" {
			rest, _ := readLine(in)
			if rest != "rest-for-next-prompt" {
				t.Errorf("prompt read past its line: next line %q", rest)
			}
		}
	}
}

// Measured on 3 servers: a node loss took 63 s (sync) to about 127 s (async)
// to promote, and async lost an acknowledged write. The text must not promise
// a faster async failover.
func TestPostgresReplicationChoicesHonestFigures(t *testing.T) {
	var b bytes.Buffer
	PostgresReplicationChoices(&b)
	out := b.String()
	for _, want := range []string{"about 1 minute when a server is lost", "can be lost", PostgresReplicationDocsURL} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	for _, bad := range []string{"70 seconds", "faster", "last few seconds"} {
		if strings.Contains(out, bad) {
			t.Errorf("stale claim %q in:\n%s", bad, out)
		}
	}
}
