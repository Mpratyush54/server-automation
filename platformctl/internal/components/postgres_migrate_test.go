package components

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

type fakeMigration struct {
	calls     []string
	failAt    string
	bitnami   bool
	inventory PGInventory
	after     PGInventory
	restored  bool
	saved     []string
}

func (f *fakeMigration) ops() PGMigrateOps {
	rec := func(name string) error {
		f.calls = append(f.calls, name)
		if name == f.failAt {
			return errors.New(name + " broke")
		}
		return nil
	}
	return PGMigrateOps{
		BitnamiPresent: func() (bool, error) { return f.bitnami, nil },
		CNPGPresent:    func() (bool, error) { return !f.bitnami, nil },
		FullBackup:     func() error { return rec("full-backup") },
		LocalBackup:    func() (string, error) { return "/host/copy", rec("local-backup") },
		Quiesce: func() (func() error, error) {
			f.calls = append(f.calls, "quiesce")
			return func() error { f.calls = append(f.calls, "resume"); return nil }, nil
		},
		Inventory: func() (PGInventory, error) {
			if f.restored {
				return f.after, nil
			}
			return f.inventory, nil
		},
		BlockLogins:  func() ([]string, error) { return []string{"plat_shop"}, rec("block-logins") },
		AllowLogins:  func(r []string) error { return rec("allow-logins:" + strings.Join(r, ",")) },
		Dump:         func(dir string) error { return rec("dump") },
		KeepVolume:   func() error { return rec("keep-volume") },
		Uninstall:    func() error { f.bitnami = false; return rec("uninstall") },
		LivePassword: func() string { return "live-password" },
		InstallCNPG:  func(cfg *config.Config) error { return rec("install-cnpg:" + cfg.PostgresPassword) },
		Restore: func(dir string) error {
			if err := rec("restore"); err != nil {
				return err
			}
			f.restored = true
			return nil
		},
		SaveConfig:     func(cfg *config.Config) error { f.saved = append(f.saved, cfg.PostgresEngine); return nil },
		EnableArchive:  func(cfg *config.Config) error { return rec("archive") },
		DeleteCNPG:     func() error { f.bitnami = true; return rec("delete-cnpg") },
		InstallBitnami: func(cfg *config.Config) error { return rec("install-bitnami") },
	}
}

func migrateSandbox(t *testing.T) {
	t.Helper()
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	old := PGMigrateDir
	PGMigrateDir = filepath.Join(t.TempDir(), "migrate")
	t.Cleanup(func() { state.SetPath(state.DefaultPath); PGMigrateDir = old })
}

func TestMigratePostgresResumesAfterFailure(t *testing.T) {
	migrateSandbox(t)
	inv := PGInventory{Major: 18, Databases: map[string]int{"platform": 40, "plat_shop_production": 3}, Users: 2}
	f := &fakeMigration{bitnami: true, inventory: inv, after: inv, failAt: "restore"}
	cfg := &config.Config{Profile: config.ProfileStandard, PostgresPassword: "old", PostgresEngine: config.PostgresEngineBitnami}
	var out bytes.Buffer
	err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &out})
	if err == nil || !strings.Contains(err.Error(), "migration step restore failed") || !strings.Contains(err.Error(), "re-run") {
		t.Fatal(err)
	}
	want := "local-backup full-backup quiesce block-logins dump keep-volume uninstall install-cnpg:live-password restore resume"
	if got := strings.Join(f.calls, " "); got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	if _, err := os.Stat(filepath.Join(PGMigrateDir, "roles.json")); err != nil {
		t.Fatal(err)
	}
	// Resume: finished steps are skipped, Bitnami is already gone.
	f.calls, f.failAt = nil, ""
	if err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &out}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, " "); got != "quiesce restore allow-logins:plat_shop archive resume" {
		t.Fatal(got)
	}
	if cfg.PostgresEngine != config.PostgresEngineCNPG || f.saved[len(f.saved)-1] != config.PostgresEngineCNPG {
		t.Fatal(cfg.PostgresEngine, f.saved)
	}
	// Idempotent once done.
	f.calls = nil
	if err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &out}); err != nil || len(f.calls) != 0 {
		t.Fatal(err, f.calls)
	}
}

func TestMigratePostgresVerificationFailureStops(t *testing.T) {
	migrateSandbox(t)
	f := &fakeMigration{bitnami: true,
		inventory: PGInventory{Major: 18, Databases: map[string]int{"platform": 40, "plat_a": 2}, Users: 3},
		after:     PGInventory{Major: 18, Databases: map[string]int{"platform": 40}, Users: 3}}
	cfg := &config.Config{Profile: config.ProfileStandard}
	err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), "database plat_a missing") {
		t.Fatal(err)
	}
	for _, c := range f.calls {
		if c == "archive" {
			t.Fatal("archiving must not start after a failed verification")
		}
	}
	if state.IsDone(pgMigrateKey("verify")) {
		t.Fatal("verify recorded")
	}
}

func TestMigratePostgresDryRunAndChecks(t *testing.T) {
	migrateSandbox(t)
	f := &fakeMigration{bitnami: true, inventory: PGInventory{Major: 18, Databases: map[string]int{"platform": 1}, Users: 1}}
	var out bytes.Buffer
	if err := MigratePostgresToCNPG(&config.Config{}, f.ops(), PGMigrateOptions{DryRun: true, Out: &out}); err != nil {
		t.Fatal(err)
	}
	if len(f.calls) != 0 || !strings.Contains(out.String(), "Dry run: nothing changed") || !strings.Contains(out.String(), "1. backup") {
		t.Fatal(f.calls, out.String())
	}
	f.inventory.Major = 99
	if err := MigratePostgresToCNPG(&config.Config{}, f.ops(), PGMigrateOptions{DryRun: true, Out: &out}); err == nil || !strings.Contains(err.Error(), "newer than the CloudNativePG image") {
		t.Fatal(err)
	}
	// Already on CNPG: recorded, nothing else.
	f = &fakeMigration{bitnami: false}
	cfg := &config.Config{}
	if err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &out}); err != nil || cfg.PostgresEngine != config.PostgresEngineCNPG || len(f.calls) != 0 {
		t.Fatal(err, cfg.PostgresEngine, f.calls)
	}
	// Without full backups configured the migration still runs, with a notice.
	migrateSandbox(t)
	f = &fakeMigration{bitnami: true, inventory: PGInventory{Major: 18, Databases: map[string]int{}}, after: PGInventory{Databases: map[string]int{}}}
	ops := f.ops()
	ops.FullBackup = nil
	out.Reset()
	if err := MigratePostgresToCNPG(&config.Config{}, ops, PGMigrateOptions{Out: &out}); err != nil || !strings.Contains(out.String(), "encrypted backups are not set up") {
		t.Fatal(err, out.String())
	}
}

func TestMigratePostgresRollback(t *testing.T) {
	migrateSandbox(t)
	inv := PGInventory{Major: 18, Databases: map[string]int{"platform": 1}, Users: 1}
	f := &fakeMigration{bitnami: true, inventory: inv, after: inv}
	cfg := &config.Config{Profile: config.ProfileStandard}
	if err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	f.calls = nil
	if err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Rollback: true, Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, " "); got != "quiesce delete-cnpg install-bitnami allow-logins:plat_shop resume" {
		t.Fatal(got)
	}
	if cfg.PostgresEngine != config.PostgresEngineBitnami || state.IsDone(pgMigrateKey("backup")) {
		t.Fatal("rollback must record bitnami and clear the migration state")
	}
	// Rollback before the release was removed only re-allows logins.
	migrateSandbox(t)
	f = &fakeMigration{bitnami: true, inventory: inv, failAt: "dump"}
	cfg = &config.Config{Profile: config.ProfileStandard}
	_ = MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Out: &bytes.Buffer{}})
	f.calls = nil
	if err := MigratePostgresToCNPG(cfg, f.ops(), PGMigrateOptions{Rollback: true, Out: &bytes.Buffer{}}); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, " "); got != "allow-logins:plat_shop" {
		t.Fatal(got)
	}
}

func TestDollarQuoteAndInventoryCompare(t *testing.T) {
	q, err := dollarQuote(`["a'b","c$d"]`)
	if err != nil || !strings.HasPrefix(q, "$p") || !strings.HasSuffix(q, "$") || !strings.Contains(q, `["a'b","c$d"]`) {
		t.Fatal(q, err)
	}
	want := PGInventory{Databases: map[string]int{"a": 2}, Users: 1}
	if err := want.Compare(PGInventory{Databases: map[string]int{"a": 3, "b": 1}, Users: 4}); err != nil {
		t.Fatal(err)
	}
	if err := want.Compare(PGInventory{Databases: map[string]int{"a": 1}}); err == nil || !strings.Contains(err.Error(), "1 of 2 tables") || !strings.Contains(err.Error(), "users 0 of 1") {
		t.Fatal(err)
	}
	for _, s := range []string{pgLoginRolesSQL, pgInventorySQL, pgTablesSQL} {
		if strings.Contains(s, "\r") || !strings.HasSuffix(s, ";") {
			t.Fatal(s)
		}
	}
}

// Rollback deletes the Cluster's superuser Secret (it blocked the Bitnami
// chart on the #186 rollback test) but never a Helm-managed object.
func TestPGShouldDelete(t *testing.T) {
	for in, want := range map[string]bool{"postgresql/": true, "postgresql/Helm": false, "": false, "/": false, "postgresql-monitoring/kubectl": true} {
		if got := pgShouldDelete(in); got != want {
			t.Fatalf("%q: got %v", in, got)
		}
	}
}
