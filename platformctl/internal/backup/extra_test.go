package backup

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type quiesceDriver struct {
	fakeDriver
	events []string
}

func (d *quiesceDriver) Restore(component, dir string) error {
	d.events = append(d.events, "restore:"+component)
	return d.fakeDriver.Restore(component, dir)
}
func (d *quiesceDriver) Quiesce() (func() error, error) {
	d.events = append(d.events, "quiesce")
	return func() error { d.events = append(d.events, "resume"); return nil }, nil
}

func TestRestoreQuiescesAroundLogicalRestore(t *testing.T) {
	k := identity(t)
	c := engineConfig(t, k)
	d := &quiesceDriver{}
	m, e := Create(c, "test", d)
	if e != nil {
		t.Fatal(e)
	}
	if e = Restore(c.Target, m.ID, "", []byte(k.String()), d); e != nil {
		t.Fatal(e)
	}
	want := []string{"quiesce", "restore:postgres", "restore:config", "resume"}
	if !reflect.DeepEqual(d.events, want) {
		t.Fatalf("got %v want %v", d.events, want)
	}
	// A corrupt artifact is rejected while staging: nothing is stopped.
	d.events = nil
	target, _ := ParseTarget(c.Target)
	os.WriteFile(filepath.Join(target.Path, m.ID, "config.tar.age"), []byte("bad"), 0600)
	if e = Restore(c.Target, m.ID, "", []byte(k.String()), d); e == nil || len(d.events) != 0 {
		t.Fatal("corrupt backup quiesced or restored", e, d.events)
	}
}

func TestRestoreWithWrongIdentityTouchesNothing(t *testing.T) {
	k := identity(t)
	c := engineConfig(t, k)
	d := &quiesceDriver{}
	m, e := Create(c, "test", d)
	if e != nil {
		t.Fatal(e)
	}
	if e = Restore(c.Target, m.ID, "", []byte(identity(t).String()), d); e == nil || len(d.events) != 0 {
		t.Fatal("wrong identity accepted", e, d.events)
	}
	if e = Restore(c.Target, m.ID, "mongo", []byte(k.String()), d); e == nil {
		t.Fatal("absent component accepted")
	}
}

func TestRequiredTools(t *testing.T) {
	got := RequiredTools([]string{"config", "postgres"}, false, false)
	if !reflect.DeepEqual(got, []string{"bash", "kubectl"}) {
		t.Fatal(got)
	}
	got = RequiredTools([]string{"config", "postgres", "minio", "k3s"}, true, false)
	if !reflect.DeepEqual(got, []string{"bash", "jq", "kubectl", "mc", "sqlite3"}) {
		t.Fatal(got)
	}
	got = RequiredTools([]string{"config", "redis", "k3s"}, false, true)
	if !reflect.DeepEqual(got, []string{"bash", "jq", "kubectl"}) {
		t.Fatal(got)
	}
}

func TestCheckToolsNamesEveryMissingTool(t *testing.T) {
	old := lookPath
	defer func() { lookPath = old }()
	lookPath = func(name string) (string, error) {
		if name == "kubectl" {
			return "/usr/bin/kubectl", nil
		}
		return "", errors.New("missing")
	}
	e := CheckTools([]string{"kubectl", "mc", "jq"})
	if e == nil || !strings.Contains(e.Error(), "mc, jq") {
		t.Fatal(e)
	}
	if e = CheckTools([]string{"kubectl"}); e != nil {
		t.Fatal(e)
	}
}

func TestWriteMetricsFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "metrics")
	s := Status{ID: "x", Success: false, FinishedAt: time.Unix(1767225600, 0).UTC(), DurationSeconds: 2.5, Bytes: 42, LastSuccessTimestamp: 1767139200}
	if e := WriteMetricsFile(dir, "restore-test", s); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(filepath.Join(dir, "platform_backup_restore_test.prom"))
	if e != nil {
		t.Fatal(e)
	}
	for _, want := range []string{
		`platform_backup_success{operation="restore-test"} 0`,
		`platform_backup_last_success_timestamp_seconds{operation="restore-test"} 1767139200`,
		`platform_backup_size_bytes{operation="restore-test"} 42`,
		`platform_backup_duration_seconds{operation="restore-test"} 2.5`,
	} {
		if !strings.Contains(string(b), want) {
			t.Fatalf("missing %q in\n%s", want, b)
		}
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatal("temporary metrics file left behind", entries)
	}
	if e := WriteMetricsFile(dir, `bad"`, s); e == nil {
		t.Fatal("label injection accepted")
	}
}

func TestAlertRulesTargetKubePrometheusRelease(t *testing.T) {
	for _, want := range []string{"kind: PrometheusRule", "release: kube-prometheus", "PlatformBackupFailed", "PlatformRestoreTestFailed", "PlatformBackupStale"} {
		if !strings.Contains(AlertsYAML, want) {
			t.Fatalf("alerts missing %q", want)
		}
	}
	for _, want := range []string{"name: platform-backup-nightly", "concurrencyPolicy: Forbid", "priorityClassName: platform-backup-low", "limits:", "ionice"} {
		if !strings.Contains(ScheduleYAML, want) {
			t.Fatalf("schedule missing %q", want)
		}
	}
}

func TestEmbeddedScriptsParse(t *testing.T) {
	bash, e := exec.LookPath("bash")
	if e != nil {
		t.Skip("bash not available")
	}
	for name, body := range map[string]string{"capture": captureScript, "restore": restoreScript} {
		f := filepath.Join(t.TempDir(), name+".sh")
		if e := os.WriteFile(f, []byte(strings.ReplaceAll(commonScript+"\n"+body, "\r\n", "\n")), 0600); e != nil {
			t.Fatal(e)
		}
		if out, e := exec.Command(bash, "-n", f).CombinedOutput(); e != nil {
			t.Fatalf("%s: %v\n%s", name, e, out)
		}
		// Secrets are resolved inside containers, never interpolated by the host.
		if strings.Contains(body, "$POSTGRES_PASSWORD\"") || strings.Contains(body, "PGPASSWORD=$(kubectl") {
			t.Fatalf("%s reads database secrets on the host", name)
		}
	}
}

// Regression: sqlite3 '.backup' restarts whenever k3s writes (continuously),
// so the k3s capture spun for 10+ minutes on a live cluster.
func TestK3sSQLiteCaptureUsesSnapshotNotOnlineBackup(t *testing.T) {
	if strings.Contains(captureScript, "'.backup") {
		t.Fatal("k3s SQLite capture must not use the restartable online backup API")
	}
	if !strings.Contains(captureScript, "VACUUM INTO") || !strings.Contains(captureScript, "quick_check") {
		t.Fatal("k3s SQLite capture must snapshot with VACUUM INTO and verify it")
	}
}

func TestHADatastoreBackupHelpers(t *testing.T) {
	for _, want := range []string{
		"mongo_pod()",
		"redis_master_pod()",
		"isWritablePrimary",
		"app.kubernetes.io/component=node",
		"role:master",
	} {
		if !strings.Contains(commonScript, want) {
			t.Fatalf("common.sh missing %q", want)
		}
	}
	if !strings.Contains(captureScript, "p=$(mongo_pod)") || !strings.Contains(captureScript, "p=$(redis_master_pod)") {
		t.Fatal("capture must use mongo_pod / redis_master_pod")
	}
	if !strings.Contains(captureScript, "-c redis") {
		t.Fatal("redis capture must exec the redis container")
	}
	for _, want := range []string{
		"p=$(mongo_pod)",
		"p=$(redis_master_pod)",
		"restore_redis_pvc()",
		"redis-data-$sts-$i",
		"sts/redis-node",
		"sts/minio",
	} {
		if !strings.Contains(restoreScript, want) {
			t.Fatalf("restore.sh missing %q", want)
		}
	}
}

// "$PWHELPER" ends with "}": text appended without a separator ("}export ...")
// is a bash syntax error. redis_master_pod hid it behind 2>/dev/null, so ha
// backups never found the Redis master (3-node test).
func TestPWHelperIsAlwaysFollowedBySeparator(t *testing.T) {
	for name, s := range map[string]string{"common.sh": commonScript, "capture.sh": captureScript, "restore.sh": restoreScript} {
		s = strings.ReplaceAll(s, "\r\n", "\n")
		for i := 0; ; {
			j := strings.Index(s[i:], `"$PWHELPER"'`)
			if j < 0 {
				break
			}
			at := i + j + len(`"$PWHELPER"'`)
			if at < len(s) && s[at] != '\n' && s[at] != ';' && s[at] != ' ' {
				t.Errorf("%s: $PWHELPER followed by %q (needs a newline or ';')", name, s[at:min(at+20, len(s))])
			}
			i = at
		}
	}
}
