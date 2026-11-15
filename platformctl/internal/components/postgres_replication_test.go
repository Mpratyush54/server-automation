package components

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestRenderPostgresClusterReplicationModes(t *testing.T) {
	for _, tc := range []struct {
		profile, mode string
		want          any
	}{
		{config.ProfileHA, "", pgSyncSpec()},
		{config.ProfileHA, "sync", pgSyncSpec()},
		{config.ProfileHA, "SYNC", pgSyncSpec()},
		{config.ProfileHA, "async", nil},
		{config.ProfileStandard, "sync", nil}, // one instance: never synchronous
		{config.ProfileStandard, "async", nil},
	} {
		cfg := &config.Config{Profile: tc.profile, PostgresReplication: tc.mode}
		m, err := renderPostgresCluster(cfg, pgClusterOptions{})
		if err != nil {
			t.Fatalf("%s/%s: %v", tc.profile, tc.mode, err)
		}
		pg := m["spec"].(map[string]any)["postgresql"].(map[string]any)
		got, ok := pg["synchronous"]
		if tc.want == nil {
			if ok {
				t.Errorf("%s/%s: synchronous = %v, want none", tc.profile, tc.mode, got)
			}
		} else if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s/%s: synchronous = %v", tc.profile, tc.mode, got)
		}
		// Everything else in the stanza stays.
		if pg["parameters"] == nil || pg["shared_preload_libraries"] == nil {
			t.Errorf("%s/%s: postgresql stanza lost settings: %v", tc.profile, tc.mode, pg)
		}
	}
	if _, err := renderPostgresCluster(&config.Config{Profile: config.ProfileHA, PostgresReplication: "preferred"}, pgClusterOptions{}); err == nil {
		t.Fatal("invalid replication mode rendered")
	}
}

func TestPGReplicationPatch(t *testing.T) {
	p, err := pgReplicationPatch("async")
	if err != nil || p != `{"spec":{"postgresql":{"synchronous":null}}}` {
		t.Fatal(p, err)
	}
	p, err = pgReplicationPatch("sync")
	if err != nil || p != `{"spec":{"postgresql":{"synchronous":{"dataDurability":"preferred","method":"any","number":1}}}}` {
		t.Fatal(p, err)
	}
	if _, err := pgReplicationPatch("other"); err == nil {
		t.Fatal("invalid mode patched")
	}
}

func TestWritePostgresHAStatusReplication(t *testing.T) {
	for raw, want := range map[string]string{
		`{"spec":{"instances":3,"postgresql":{"synchronous":{"method":"any","number":1,"dataDurability":"preferred"}}}}`: "Replication: sync",
		`{"spec":{"instances":3,"postgresql":{}}}`: "Replication: async",
		`{"spec":{"instances":1}}`:                 "Replication: single instance",
	} {
		var b bytes.Buffer
		if err := writePostgresHAStatus(&b, []byte(raw)); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(b.String(), want) {
			t.Errorf("%s: %s", raw, b.String())
		}
	}
}

type fakeReplication struct {
	cluster  string
	patches  []string
	saved    []string
	names    []string // successive SHOW results
	showErr  error
	sleeps   int
	patchErr error
}

func (f *fakeReplication) ops() PGReplicationOps {
	return PGReplicationOps{
		ClusterJSON: func() ([]byte, error) { return []byte(f.cluster), nil },
		Patch: func(p string) error {
			f.patches = append(f.patches, p)
			return f.patchErr
		},
		StandbyNames: func(primary string) (string, error) {
			if primary != "postgresql-2" {
				return "", errors.New("wrong pod " + primary)
			}
			if f.showErr != nil {
				return "", f.showErr
			}
			n := f.names[0]
			if len(f.names) > 1 {
				f.names = f.names[1:]
			}
			return n, nil
		},
		Save:  func(m string) error { f.saved = append(f.saved, m); return nil },
		Sleep: func(time.Duration) { f.sleeps++ },
		Wait:  15 * time.Second,
	}
}

const syncCluster = `{"spec":{"instances":3,"postgresql":{"synchronous":{"method":"any","number":1,"dataDurability":"preferred"}}},"status":{"currentPrimary":"postgresql-2"}}`
const asyncCluster = `{"spec":{"instances":3,"postgresql":{}},"status":{"currentPrimary":"postgresql-2"}}`

func TestSetPostgresReplication(t *testing.T) {
	ha := func() *config.Config { return &config.Config{Profile: config.ProfileHA, PostgresReplication: "sync"} }

	// sync → async: patch, save, wait until the primary stops waiting.
	f := &fakeReplication{cluster: syncCluster, names: []string{`ANY 1 ("postgresql-1","postgresql-3")`, ""}}
	var out bytes.Buffer
	cfg := ha()
	if err := SetPostgresReplication(cfg, "ASYNC", f.ops(), &out); err != nil {
		t.Fatal(err)
	}
	if len(f.patches) != 1 || !strings.Contains(f.patches[0], `"synchronous":null`) || !reflect.DeepEqual(f.saved, []string{"async"}) || cfg.PostgresReplication != "async" {
		t.Fatalf("patches=%v saved=%v cfg=%q", f.patches, f.saved, cfg.PostgresReplication)
	}
	if f.sleeps != 1 || !strings.Contains(out.String(), "no restart") || !strings.Contains(out.String(), "no longer waits") || !strings.Contains(out.String(), config.PostgresReplicationDocsURL) {
		t.Fatalf("sleeps=%d\n%s", f.sleeps, out.String())
	}

	// async → sync.
	f = &fakeReplication{cluster: asyncCluster, names: []string{`ANY 1 ("postgresql-1","postgresql-3")`}}
	out.Reset()
	if err := SetPostgresReplication(ha(), "sync", f.ops(), &out); err != nil {
		t.Fatal(err)
	}
	var patch map[string]map[string]map[string]any
	if len(f.patches) != 1 || json.Unmarshal([]byte(f.patches[0]), &patch) != nil || !reflect.DeepEqual(patch["spec"]["postgresql"]["synchronous"], map[string]any{"method": "any", "number": 1.0, "dataDurability": "preferred"}) {
		t.Fatal(f.patches)
	}
	if !strings.Contains(out.String(), "waits for: ANY 1") {
		t.Fatal(out.String())
	}

	// Already in that mode: no patch, still saved.
	f = &fakeReplication{cluster: syncCluster, names: []string{"ANY 1 (x)"}}
	out.Reset()
	if err := SetPostgresReplication(ha(), "sync", f.ops(), &out); err != nil || len(f.patches) != 0 || len(f.saved) != 1 || !strings.Contains(out.String(), "already sync") {
		t.Fatal(err, f.patches, f.saved, out.String())
	}

	// PostgreSQL never picks it up: a warning, not a failure.
	f = &fakeReplication{cluster: syncCluster, names: []string{"ANY 1 (x)"}}
	out.Reset()
	if err := SetPostgresReplication(ha(), "async", f.ops(), &out); err != nil || !strings.Contains(out.String(), "WARNING: the primary still reports") || f.sleeps != 3 {
		t.Fatal(err, f.sleeps, out.String())
	}
	f = &fakeReplication{cluster: syncCluster, showErr: errors.New("exec failed")}
	out.Reset()
	if err := SetPostgresReplication(ha(), "async", f.ops(), &out); err != nil || !strings.Contains(out.String(), "could not read synchronous_standby_names") {
		t.Fatal(err, out.String())
	}

	// Failures and refusals.
	f = &fakeReplication{cluster: syncCluster, patchErr: errors.New("denied")}
	if err := SetPostgresReplication(ha(), "async", f.ops(), &out); err == nil || len(f.saved) != 0 {
		t.Fatal("patch failure saved the mode", err)
	}
	if err := SetPostgresReplication(ha(), "preferred", (&fakeReplication{cluster: syncCluster}).ops(), &out); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if err := SetPostgresReplication(&config.Config{Profile: config.ProfileStandard}, "async", (&fakeReplication{cluster: syncCluster}).ops(), &out); err == nil || !strings.Contains(err.Error(), "ha profile") {
		t.Fatal("single-server profile accepted", err)
	}
	if err := SetPostgresReplication(ha(), "async", (&fakeReplication{cluster: `{"spec":{"instances":1}}`}).ops(), &out); err == nil {
		t.Fatal("single instance accepted")
	}
}

func TestPostgresReplicationStatus(t *testing.T) {
	var out bytes.Buffer
	cfg := &config.Config{Profile: config.ProfileHA, PostgresReplication: "sync"}
	if err := PostgresReplicationStatus(cfg, (&fakeReplication{cluster: asyncCluster}).ops(), &out); err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"Saved choice (POSTGRES_REPLICATION): sync", "Running cluster: async", "WARNING: the cluster runs async but sync is saved", "replication set sync|async", config.PostgresReplicationDocsURL} {
		if !strings.Contains(out.String(), s) {
			t.Fatalf("missing %q:\n%s", s, out.String())
		}
	}
	out.Reset()
	if err := PostgresReplicationStatus(cfg, (&fakeReplication{cluster: syncCluster}).ops(), &out); err != nil || strings.Contains(out.String(), "WARNING") {
		t.Fatal(err, out.String())
	}
	out.Reset()
	if err := PostgresReplicationStatus(&config.Config{Profile: config.ProfileStandard}, PGReplicationOps{}, &out); err != nil || !strings.Contains(out.String(), "single instance") {
		t.Fatal(err, out.String())
	}
}
