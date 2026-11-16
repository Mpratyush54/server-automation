package components

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// Bitnami PostgreSQL -> CloudNativePG migration (#180, #183, #186).
//
// `platformctl postgres migrate` moves an existing install to a CloudNativePG
// cluster (one instance on single-node profiles, three on ha) so it gets WAL
// archiving and point-in-time recovery. It is resumable: every finished step
// is recorded in the state file, and a re-run continues after the last one.
//
//  1. backup     encrypted archive (when backups are set up) + host copy of credentials
//  2. stop       platform API scaled to zero; project roles set NOLOGIN, sessions ended
//  3. dump       pg_dumpall --globals-only + pg_dump -Fc per database, kept on the host
//  4. remove     Bitnami release uninstalled; its PVC kept (PV reclaim policy Retain)
//  5. cnpg       CloudNativePG cluster created with the same superuser password
//  6. restore    dump restored, project roles allowed to log in again
//  7. verify     databases, table counts and platform users match the dump
//  8. archive    POSTGRES_ENGINE=cnpg saved; WAL archiving + first base backup
//  9. resume     platform API back
//
// `--rollback` reinstalls the Bitnami release on the kept PVC (data as of the
// start of the migration) and removes the CloudNativePG cluster.

// PGMigrateDir keeps the dump and the role list; a variable for tests.
var PGMigrateDir = "/var/lib/platform/migrations/postgres-cnpg"

// Migration step keys in the state file.
var pgMigrateSteps = []string{"backup", "stop", "dump", "remove", "cnpg", "restore", "verify", "archive"}

func pgMigrateKey(step string) string { return "pg-migrate." + step }

// PGMigrateOps are the side effects of the migration; tests replace them.
type PGMigrateOps struct {
	BitnamiPresent func() (bool, error)
	CNPGPresent    func() (bool, error)
	FullBackup     func() error // encrypted archive; nil when backups are not configured
	LocalBackup    func() (string, error)
	Quiesce        func() (func() error, error)
	Inventory      func() (PGInventory, error)
	BlockLogins    func() ([]string, error)
	AllowLogins    func(roles []string) error
	Dump           func(dir string) error
	KeepVolume     func() error
	Uninstall      func() error
	LivePassword   func() string
	InstallCNPG    func(cfg *config.Config) error
	Restore        func(dir string) error
	SaveConfig     func(cfg *config.Config) error
	EnableArchive  func(cfg *config.Config) error
	DeleteCNPG     func() error
	InstallBitnami func(cfg *config.Config) error
}

// PGInventory is what verification compares: tables per database and the
// number of platform users. Major is the server's major version.
type PGInventory struct {
	Major     int            `json:"major"`
	Databases map[string]int `json:"databases"`
	Users     int            `json:"users"`
}

// Compare reports what the restored cluster lacks.
func (want PGInventory) Compare(got PGInventory) error {
	var missing []string
	for db, n := range want.Databases {
		g, ok := got.Databases[db]
		if !ok {
			missing = append(missing, "database "+db+" missing")
		} else if g < n {
			missing = append(missing, fmt.Sprintf("database %s has %d of %d tables", db, g, n))
		}
	}
	if got.Users < want.Users {
		missing = append(missing, fmt.Sprintf("platform users %d of %d", got.Users, want.Users))
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		return fmt.Errorf("verification failed: %s", strings.Join(missing, "; "))
	}
	return nil
}

// PGMigrateOptions select the run.
type PGMigrateOptions struct {
	DryRun, Rollback bool
	Out              io.Writer
}

func pgMigratePlan(w io.Writer, cfg *config.Config) {
	fmt.Fprintf(w, "PostgreSQL migration plan (Bitnami release -> CloudNativePG, %d instance(s)):\n", pgInstances(cfg))
	descr := map[string]string{
		"backup":  "encrypted backup (when set up) and a host copy of credentials",
		"stop":    "stop the platform API, block project database logins, end sessions",
		"dump":    "dump roles and every database to " + PGMigrateDir,
		"remove":  "uninstall the Bitnami release; keep its volume for rollback",
		"cnpg":    "create the CloudNativePG cluster (same password, same postgresql.databases address)",
		"restore": "restore the dump and allow project logins again",
		"verify":  "compare databases, table counts and platform users with the dump",
		"archive": "record POSTGRES_ENGINE=cnpg, turn on WAL archiving and take the first base backup",
	}
	for i, s := range pgMigrateSteps {
		mark := " "
		if state.IsDone(pgMigrateKey(s)) {
			mark = "x"
		}
		fmt.Fprintf(w, "  [%s] %d. %-8s %s\n", mark, i+1, s, descr[s])
	}
	fmt.Fprintln(w, "  Downtime: the platform API and project database connections are stopped from step 2 until the end.")
}

// MigratePostgresToCNPG runs (or resumes) the migration.
func MigratePostgresToCNPG(cfg *config.Config, ops PGMigrateOps, o PGMigrateOptions) (err error) {
	w := o.Out
	if w == nil {
		w = os.Stdout
	}
	if o.Rollback {
		return rollbackPostgresMigration(cfg, ops, o)
	}
	if state.IsDone(pgMigrateKey("archive")) && cfg.PostgresEngine == config.PostgresEngineCNPG {
		fmt.Fprintln(w, "PostgreSQL already runs on CloudNativePG; nothing to migrate.")
		return nil
	}
	started := state.IsDone(pgMigrateKey("backup"))
	bitnami, err := ops.BitnamiPresent()
	if err != nil {
		return err
	}
	if !bitnami && !state.IsDone(pgMigrateKey("remove")) {
		cnpg, err := ops.CNPGPresent()
		if err != nil {
			return err
		}
		if cnpg {
			fmt.Fprintln(w, "PostgreSQL already runs on CloudNativePG; recording it.")
			cfg.PostgresEngine = config.PostgresEngineCNPG
			return ops.SaveConfig(cfg)
		}
		return fmt.Errorf("no Bitnami PostgreSQL release found in namespace databases; nothing to migrate")
	}
	pgMigratePlan(w, cfg)
	if o.DryRun {
		inv, err := ops.Inventory()
		if err != nil {
			return fmt.Errorf("read the current databases: %w", err)
		}
		if err := pgMajorCompatible(inv.Major); err != nil {
			return err
		}
		fmt.Fprintf(w, "Current PostgreSQL %d: %d database(s), %d platform user(s). Dry run: nothing changed.\n", inv.Major, len(inv.Databases), inv.Users)
		return nil
	}
	if started {
		fmt.Fprintln(w, "Resuming the migration after the last finished step.")
	}
	if err := os.MkdirAll(PGMigrateDir, 0700); err != nil {
		return err
	}
	step := func(name string, fn func() error) error {
		if state.IsDone(pgMigrateKey(name)) {
			return nil
		}
		fmt.Fprintf(w, "  ■ %s\n", name)
		if err := fn(); err != nil {
			return fmt.Errorf("migration step %s failed: %w; fix the cause and re-run `sudo platformctl postgres migrate --confirm` to continue, or roll back with `--rollback --confirm`", name, err)
		}
		return state.MarkDone(pgMigrateKey(name))
	}
	inventoryFile := filepath.Join(PGMigrateDir, "inventory.json")
	rolesFile := filepath.Join(PGMigrateDir, "roles.json")
	dumpDir := filepath.Join(PGMigrateDir, "dump")

	if err := step("backup", func() error {
		inv, err := ops.Inventory()
		if err != nil {
			return err
		}
		if err := pgMajorCompatible(inv.Major); err != nil {
			return err
		}
		if dir, err := ops.LocalBackup(); err != nil {
			return err
		} else if dir != "" {
			fmt.Fprintf(w, "    credentials copied to %s\n", dir)
		}
		if ops.FullBackup == nil {
			fmt.Fprintln(w, "    encrypted backups are not set up (backup init); the dump in the next steps is the only copy, kept on this server")
			return nil
		}
		return ops.FullBackup()
	}); err != nil {
		return err
	}
	// The API stays stopped until the end, also on a resumed run.
	resume, err := ops.Quiesce()
	if err != nil {
		return fmt.Errorf("stop the platform API: %w", err)
	}
	defer func() {
		if e := resume(); e != nil && err == nil {
			err = fmt.Errorf("restart the platform API: %w", e)
		}
	}()
	if err := step("stop", func() error {
		roles, err := ops.BlockLogins()
		if err != nil {
			return err
		}
		b, _ := json.Marshal(roles)
		return config.WriteFileSync(rolesFile, string(b), 0600)
	}); err != nil {
		return err
	}
	if err := step("dump", func() error {
		inv, err := ops.Inventory()
		if err != nil {
			return err
		}
		b, _ := json.Marshal(inv)
		if err := config.WriteFileSync(inventoryFile, string(b), 0600); err != nil {
			return err
		}
		_ = os.RemoveAll(dumpDir)
		if err := os.MkdirAll(dumpDir, 0700); err != nil {
			return err
		}
		return ops.Dump(dumpDir)
	}); err != nil {
		return err
	}
	if err := step("remove", func() error {
		// The password the platform uses now becomes the new cluster's.
		if p := ops.LivePassword(); p != "" {
			cfg.PostgresPassword = p
		}
		if err := ops.SaveConfig(cfg); err != nil {
			return err
		}
		if err := ops.KeepVolume(); err != nil {
			return err
		}
		return ops.Uninstall()
	}); err != nil {
		return err
	}
	if err := step("cnpg", func() error {
		cfg.PostgresEngine = config.PostgresEngineCNPG
		return ops.InstallCNPG(cfg)
	}); err != nil {
		return err
	}
	if err := step("restore", func() error {
		if err := ops.Restore(dumpDir); err != nil {
			return err
		}
		roles, err := readRoles(rolesFile)
		if err != nil {
			return err
		}
		return ops.AllowLogins(roles)
	}); err != nil {
		return err
	}
	if err := step("verify", func() error {
		var want PGInventory
		b, err := os.ReadFile(inventoryFile)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(b, &want); err != nil {
			return err
		}
		got, err := ops.Inventory()
		if err != nil {
			return err
		}
		if err := want.Compare(got); err != nil {
			return err
		}
		fmt.Fprintf(w, "    %d database(s) and %d platform user(s) match the dump\n", len(want.Databases), want.Users)
		return nil
	}); err != nil {
		return err
	}
	if err := step("archive", func() error {
		cfg.PostgresEngine = config.PostgresEngineCNPG
		if err := ops.SaveConfig(cfg); err != nil {
			return err
		}
		return ops.EnableArchive(cfg)
	}); err != nil {
		return err
	}
	fmt.Fprintf(w, "PostgreSQL now runs on CloudNativePG with WAL archiving. The old volume (PVC databases/data-postgresql-0) and the dump in %s are kept for rollback; delete them once you are satisfied.\n", PGMigrateDir)
	return nil
}

func readRoles(file string) ([]string, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var roles []string
	return roles, json.Unmarshal(b, &roles)
}

func rollbackPostgresMigration(cfg *config.Config, ops PGMigrateOps, o PGMigrateOptions) (err error) {
	w := o.Out
	if !state.IsDone(pgMigrateKey("remove")) {
		for _, s := range pgMigrateSteps {
			_ = state.Clear(pgMigrateKey(s))
		}
		if cfg.PostgresEngine != config.PostgresEngineBitnami {
			cfg.PostgresEngine = config.PostgresEngineBitnami
			if err := ops.SaveConfig(cfg); err != nil {
				return err
			}
		}
		roles, _ := readRoles(filepath.Join(PGMigrateDir, "roles.json"))
		if len(roles) > 0 && !o.DryRun {
			if err := ops.AllowLogins(roles); err != nil {
				return err
			}
		}
		fmt.Fprintln(w, "The Bitnami release was not removed yet; migration state cleared, project logins allowed again.")
		return nil
	}
	fmt.Fprintln(w, "Rollback: reinstall the Bitnami release on the kept volume (data as of the migration start) and delete the CloudNativePG cluster. Changes made after the migration are lost.")
	if o.DryRun {
		return nil
	}
	resume, err := ops.Quiesce()
	if err != nil {
		return err
	}
	defer func() {
		if e := resume(); e != nil && err == nil {
			err = fmt.Errorf("restart the platform API: %w", e)
		}
	}()
	if err := ops.DeleteCNPG(); err != nil {
		return err
	}
	cfg.PostgresEngine = config.PostgresEngineBitnami
	if err := ops.SaveConfig(cfg); err != nil {
		return err
	}
	if err := ops.InstallBitnami(cfg); err != nil {
		return err
	}
	roles, err := readRoles(filepath.Join(PGMigrateDir, "roles.json"))
	if err != nil {
		return err
	}
	if err := ops.AllowLogins(roles); err != nil {
		return err
	}
	for _, s := range pgMigrateSteps {
		_ = state.Clear(pgMigrateKey(s))
	}
	fmt.Fprintln(w, "Rolled back to the Bitnami release.")
	return nil
}

var imageMajorRE = regexp.MustCompile(`:(\d+)\.`)

// pgMajorCompatible refuses a dump from a newer major than the CNPG image.
func pgMajorCompatible(major int) error {
	m := imageMajorRE.FindStringSubmatch(versions.CNPGPostgresImage)
	if len(m) != 2 || major == 0 {
		return nil
	}
	target, _ := strconv.Atoi(m[1])
	if major > target {
		return fmt.Errorf("the running PostgreSQL %d is newer than the CloudNativePG image (%d); upgrade platformctl first", major, target)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Live operations.

const pgPasswordHelper = `pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }`

// pgPod returns the writable PostgreSQL pod and container (CNPG primary, or
// the Bitnami pod).
func pgPod() (pod, container string, err error) {
	out, _ := shell.Output("kubectl", "-n", "databases", "get", "pod", "-l", "cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary", "-o", "jsonpath={.items[0].metadata.name}")
	if p := strings.TrimSpace(out); p != "" && !strings.Contains(p, " ") {
		return p, "postgres", nil
	}
	out, err = shell.Output("kubectl", "-n", "databases", "get", "pod", "-l", "app.kubernetes.io/instance=postgresql,app.kubernetes.io/name=postgresql", "-o", "jsonpath={.items[0].metadata.name}")
	if p := strings.TrimSpace(out); err == nil && p != "" && !strings.Contains(p, " ") {
		return p, "postgresql", nil
	}
	return "", "", fmt.Errorf("no running PostgreSQL pod in namespace databases")
}

// pgSQL runs SQL (on stdin) as postgres inside the database pod. The
// password is read there, never on the host.
func pgSQL(db, sql string) (string, error) {
	pod, container, err := pgPod()
	if err != nil {
		return "", err
	}
	c := exec.Command("kubectl", "-n", "databases", "exec", "-i", pod, "-c", container, "--", "bash", "-ec",
		pgPasswordHelper+`; export PGPASSWORD="$(pw POSTGRES_PASSWORD)"; exec psql -X -U postgres -d "$1" -At -v ON_ERROR_STOP=1`, "--", db)
	c.Stdin = strings.NewReader(sql)
	var stderr strings.Builder
	c.Stderr = &stderr
	out, err := c.Output()
	if err != nil {
		return "", fmt.Errorf("psql: %w: %s", err, trimLines(stderr.String(), 5))
	}
	return strings.TrimSpace(string(out)), nil
}

// dollarQuote wraps data in a dollar-quoted literal with a random tag.
func dollarQuote(s string) (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	tag := "$p" + hex.EncodeToString(b) + "$"
	if strings.Contains(s, tag) {
		return "", fmt.Errorf("unexpected role data")
	}
	return tag + s + tag, nil
}

const pgLoginRolesSQL = `SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]') FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname NOT LIKE 'pg\_%' AND rolname NOT IN ('streaming_replica', 'postgres');`

func pgBlockLogins() ([]string, error) {
	out, err := pgSQL("postgres", pgLoginRolesSQL)
	if err != nil {
		return nil, err
	}
	var roles []string
	if err := json.Unmarshal([]byte(out), &roles); err != nil {
		return nil, fmt.Errorf("read login roles: %w", err)
	}
	if err := pgSetLogin(roles, false); err != nil {
		return nil, err
	}
	_, err = pgSQL("postgres", `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND usename IS NOT NULL AND usename <> 'postgres' AND backend_type = 'client backend';`)
	return roles, err
}

func pgSetLogin(roles []string, login bool) error {
	if len(roles) == 0 {
		return nil
	}
	b, _ := json.Marshal(roles)
	lit, err := dollarQuote(string(b))
	if err != nil {
		return err
	}
	verb := "NOLOGIN"
	if login {
		verb = "LOGIN"
	}
	// Roles are data (format %I), never spliced into SQL text.
	sql := `DO $do$ DECLARE r text; BEGIN FOR r IN SELECT json_array_elements_text(` + lit + `::json) LOOP IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('ALTER ROLE %I ` + verb + `', r); END IF; END LOOP; END $do$;`
	_, err = pgSQL("postgres", sql)
	return err
}

const pgInventorySQL = `SELECT json_build_object('major', current_setting('server_version_num')::int / 10000, 'databases', coalesce((SELECT json_object_agg(datname, 0) FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres'), '{}'::json));`

const pgTablesSQL = `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg\_%';`

func pgInventory() (PGInventory, error) {
	var inv PGInventory
	out, err := pgSQL("postgres", pgInventorySQL)
	if err != nil {
		return inv, err
	}
	if err := json.Unmarshal([]byte(out), &inv); err != nil {
		return inv, fmt.Errorf("read databases: %w", err)
	}
	for db := range inv.Databases {
		n, err := pgSQL(db, pgTablesSQL)
		if err != nil {
			return inv, err
		}
		inv.Databases[db], _ = strconv.Atoi(n)
	}
	if _, ok := inv.Databases["platform"]; ok {
		n, err := pgSQL("platform", `SELECT CASE WHEN to_regclass('public.users') IS NULL THEN 0 ELSE (SELECT count(*) FROM public.users) END;`)
		if err != nil {
			return inv, err
		}
		inv.Users, _ = strconv.Atoi(n)
	}
	return inv, nil
}

func pgKeepBitnamiVolume() error {
	pv, err := shell.Output("kubectl", "-n", "databases", "get", "pvc", "data-postgresql-0", "-o", "jsonpath={.spec.volumeName}")
	if err != nil || strings.TrimSpace(pv) == "" {
		return fmt.Errorf("Bitnami volume data-postgresql-0 not found: %s", pv)
	}
	if out, err := shell.Output("kubectl", "patch", "pv", strings.TrimSpace(pv), "-p", `{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}`); err != nil {
		return fmt.Errorf("keep volume %s: %w: %s", pv, err, out)
	}
	if out, err := shell.Output("kubectl", "-n", "databases", "label", "pvc", "data-postgresql-0", "--overwrite", "platform.io/rollback=postgres-bitnami"); err != nil {
		return fmt.Errorf("label volume: %w: %s", err, out)
	}
	return nil
}

// LivePGMigrateOps are the real operations. fullBackup is nil when encrypted
// backups are not configured.
func LivePGMigrateOps(fullBackup func() error, saveConfig func(*config.Config) error) PGMigrateOps {
	driver := backup.HostDriver{}
	return PGMigrateOps{
		BitnamiPresent: func() (bool, error) {
			out, err := shell.Output("kubectl", "-n", "databases", "get", "statefulset", "postgresql", "--ignore-not-found", "-o", "name")
			if err != nil {
				return false, fmt.Errorf("read namespace databases: %w: %s", err, out)
			}
			return strings.TrimSpace(out) != "" || shell.RunSilent("helm", "status", "postgresql", "-n", "databases") == nil, nil
		},
		CNPGPresent: func() (bool, error) {
			return shell.RunSilent("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql") == nil, nil
		},
		FullBackup:  fullBackup,
		LocalBackup: func() (string, error) { return BackupLocalState("", "") },
		Quiesce:     driver.Quiesce,
		Inventory:   pgInventory,
		BlockLogins: pgBlockLogins,
		AllowLogins: func(roles []string) error { return pgSetLogin(roles, true) },
		Dump:        func(dir string) error { return driver.Capture("postgres", dir) },
		KeepVolume:  pgKeepBitnamiVolume,
		Uninstall: func() error {
			if out, err := shell.Output("helm", "uninstall", "postgresql", "-n", "databases", "--wait", "--timeout", "5m"); err != nil && !strings.Contains(out, "not found") {
				return fmt.Errorf("helm uninstall postgresql: %w: %s", err, trimLines(out, 5))
			}
			_ = state.Clear("postgresql.values")
			return nil
		},
		LivePassword: func() string {
			return firstFilled(kubeSecretValue("platform", platformCredsSecret, "POSTGRES_PASSWORD"), kubeSecretValue("platform", "platform-env", "POSTGRES_PASSWORD"), kubeSecretValue("databases", "postgresql", "postgres-password"))
		},
		InstallCNPG: installPostgresCNPG,
		Restore:     func(dir string) error { return driver.Restore("postgres", dir) },
		SaveConfig:  saveConfig,
		EnableArchive: func(cfg *config.Config) error {
			if err := InstallPostgresBackup(cfg); err != nil {
				return err
			}
			if cfg.InstallMonitoring {
				_ = InstallPostgresMonitoring(cfg)
			}
			return nil
		},
		DeleteCNPG: func() error {
			for _, args := range [][]string{
				{"-n", "databases", "delete", "scheduledbackups.postgresql.cnpg.io", "postgresql-daily", "--ignore-not-found"},
				{"-n", "databases", "delete", "clusters.postgresql.cnpg.io", "postgresql", "--ignore-not-found", "--wait=true", "--timeout=5m"},
				{"-n", "databases", "delete", "service", "postgresql", "--ignore-not-found"},
			} {
				if out, err := shell.Output("kubectl", args...); err != nil {
					return fmt.Errorf("kubectl %s: %w: %s", strings.Join(args, " "), err, out)
				}
			}
			// The superuser Secret and monitoring ConfigMap written for the
			// Cluster block the Bitnami chart ("Secret postgresql exists and
			// cannot be imported into the current release", found on the #186
			// rollback test). The password stays in .env and platform-env.
			if err := deleteUnlessHelmManaged("secret", "postgresql"); err != nil {
				return err
			}
			if err := deleteUnlessHelmManaged("configmap", "postgresql-monitoring"); err != nil {
				return err
			}
			_ = state.Clear("postgresql")
			_ = state.Clear("postgresql-backup")
			return nil
		},
		InstallBitnami: func(cfg *config.Config) error {
			_ = state.Clear("postgresql")
			_ = state.Clear("postgresql.values")
			return postgresqlRelease(cfg).reconcile("--wait", "--timeout", "10m")
		},
	}
}

// deleteUnlessHelmManaged removes a databases-namespace object that
// platformctl created for CloudNativePG, leaving Helm-owned objects alone.
func deleteUnlessHelmManaged(kind, name string) error {
	out, err := shell.Output("kubectl", "-n", "databases", "get", kind, name, "--ignore-not-found", "-o", `jsonpath={.metadata.name}/{.metadata.labels.app\.kubernetes\.io/managed-by}`)
	if err != nil {
		return fmt.Errorf("read %s databases/%s: %w: %s", kind, name, err, out)
	}
	if !pgShouldDelete(out) {
		return nil
	}
	if out, err := shell.Output("kubectl", "-n", "databases", "delete", kind, name, "--ignore-not-found"); err != nil {
		return fmt.Errorf("delete %s databases/%s: %w: %s", kind, name, err, out)
	}
	return nil
}

// pgShouldDelete reads "<name>/<managed-by>": present and not Helm-managed.
func pgShouldDelete(nameManagedBy string) bool {
	name, managedBy, _ := strings.Cut(strings.TrimSpace(nameManagedBy), "/")
	return name != "" && managedBy != "Helm"
}
