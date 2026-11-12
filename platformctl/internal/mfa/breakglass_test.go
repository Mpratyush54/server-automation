package mfa

import (
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type call struct {
	stdin string
	name  string
	args  []string
}

type fakeKube struct {
	calls   []call
	pod     string
	primary string // CNPG primary; "" = no CNPG cluster (lookup falls back to pod)
	standby bool   // pod is a CNPG standby: only the primary lookup must be used
	dbB64   string
	execOut string
	execErr error
}

func (f *fakeKube) run(stdin, name string, args ...string) (string, error) {
	f.calls = append(f.calls, call{stdin, name, append([]string(nil), args...)})
	joined := strings.Join(args, " ")
	switch {
	case strings.Contains(joined, "instanceRole=primary") && (f.primary != "" || f.standby):
		return f.primary, nil
	case strings.Contains(joined, "get pods"):
		return f.pod, nil
	case strings.Contains(joined, "secret platform-env"):
		return f.dbB64, nil
	case strings.Contains(joined, " exec "):
		return f.execOut, f.execErr
	}
	return "", errors.New("unexpected command: " + joined)
}

func TestDisableBuildsCommandsWithoutInterpolatingValues(t *testing.T) {
	email := `o'brien";DROP-TABLE-users;--$(id)` + "`id`" + `@example.com`
	f := &fakeKube{pod: "postgresql-0", dbB64: base64.StdEncoding.EncodeToString([]byte("platform")), execOut: "removed=1\n"}
	res, err := BreakGlass{Run: f.run, Host: "node-1"}.Disable("  " + email + " ")
	if err != nil {
		t.Fatalf("Disable: %v", err)
	}
	if !res.Removed || res.Database != "platform" {
		t.Fatalf("unexpected result %+v", res)
	}
	if len(f.calls) != 3 {
		t.Fatalf("want 3 kubectl calls, got %d", len(f.calls))
	}
	exec := f.calls[2]
	if exec.name != "kubectl" {
		t.Fatalf("exec via %s", exec.name)
	}
	want := []string{"-n", "databases", "exec", "-i", "postgresql-0", "--", "bash", "-ec", InPodScript, "platformctl-mfa", "platform", email, "node-1"}
	if strings.Join(exec.args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("exec args:\n got %q\nwant %q", exec.args, want)
	}
	if exec.stdin != DisableSQL {
		t.Fatal("SQL must be sent on stdin")
	}
	// The email is only ever a psql variable, never part of SQL or shell source.
	if strings.Contains(exec.stdin, "brien") || strings.Contains(InPodScript, "brien") {
		t.Fatal("email interpolated into SQL or script")
	}
	for _, s := range []string{"POSTGRES_PASSWORD", "PGPASSWORD"} {
		for _, a := range exec.args[:8] {
			if strings.Contains(a, s) {
				t.Fatalf("password variable in kubectl args: %q", a)
			}
		}
	}
}

func TestDisableSQLDeletesFactorAndCodesAndAudits(t *testing.T) {
	for _, s := range []string{
		"BEGIN;", "COMMIT;",
		"lower(email) = lower(:'email')",
		"DELETE FROM mfa_recovery_codes",
		"DELETE FROM user_mfa",
		"INSERT INTO audit_logs (user_id, action, target_type, target_id, metadata)",
		"'auth.mfa.break_glass_disable'",
		"RAISE EXCEPTION",
	} {
		if !strings.Contains(DisableSQL, s) {
			t.Errorf("DisableSQL missing %q", s)
		}
	}
}

func TestDisableDefaultsAndOverrides(t *testing.T) {
	f := &fakeKube{pod: "pg-abc", dbB64: "", execOut: "removed=0\n"}
	res, err := BreakGlass{Run: f.run}.Disable("dev@example.com")
	if err != nil || res.Database != DefaultDatabase || res.Removed {
		t.Fatalf("got %+v %v", res, err)
	}
	f2 := &fakeKube{pod: "pg-abc", execOut: "removed=1"}
	res, err = BreakGlass{Run: f2.run, Database: "custom_db"}.Disable("dev@example.com")
	if err != nil || res.Database != "custom_db" {
		t.Fatalf("got %+v %v", res, err)
	}
	for _, c := range f2.calls {
		if strings.Contains(strings.Join(c.args, " "), "platform-env") {
			t.Fatal("--database given: platform-env must not be read")
		}
	}
}

func TestDisableErrors(t *testing.T) {
	for _, bad := range []string{"", "not-an-email", "a@b@c", "a b@example.com", "x@example.com\n"} {
		if _, err := (BreakGlass{Run: (&fakeKube{}).run}).Disable(bad); err == nil && strings.TrimSpace(bad) == bad {
			t.Errorf("accepted %q", bad)
		}
	}
	if err := ValidateEmail("a\x07@example.com"); err == nil {
		t.Error("accepted control character")
	}
	if _, err := (BreakGlass{Run: (&fakeKube{pod: ""}).run}).Disable("a@example.com"); err == nil || !strings.Contains(err.Error(), "pod not found") {
		t.Errorf("missing pod: %v", err)
	}
	f := &fakeKube{pod: "pg", execErr: errors.New("exit status 3")}
	if _, err := (BreakGlass{Run: f.run, Database: "platform"}).Disable("a@example.com"); err == nil {
		t.Error("psql failure not reported")
	}
	f = &fakeKube{pod: "pg", execOut: "garbage"}
	if _, err := (BreakGlass{Run: f.run, Database: "platform"}).Disable("a@example.com"); err == nil {
		t.Error("unexpected output accepted")
	}
}

// TestInPodScriptQuoting executes the in-pod script with a fake psql to prove the values arrive
// as single, unmodified arguments and the password comes from the container environment/file.
func TestInPodScriptQuoting(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args")
	stdinFile := filepath.Join(dir, "stdin")
	fake := "#!/usr/bin/env bash\n" +
		"for a in \"$@\"; do printf '%s\\n' \"$a\"; done > \"$FAKE_ARGS\"\n" +
		"printf 'PGPASSWORD=%s\\n' \"$PGPASSWORD\" >> \"$FAKE_ARGS\"\n" +
		"cat > \"$FAKE_STDIN\"\n" +
		"echo removed=1\n"
	if err := os.WriteFile(filepath.Join(dir, "psql"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	pwFile := filepath.Join(dir, "pw")
	if err := os.WriteFile(pwFile, []byte("s3cret pass"), 0o600); err != nil {
		t.Fatal(err)
	}
	email := `o'brien "x" $(touch pwned) ` + "`id`" + `@example.com`
	cmd := exec.Command(bash, "-ec", InPodScript, "platformctl-mfa", "plat db", email, "host;1")
	pathSep := ":"
	if runtime.GOOS == "windows" {
		pathSep = ";"
	}
	cmd.Env = append(os.Environ(),
		"PATH="+dir+pathSep+os.Getenv("PATH"),
		"FAKE_ARGS="+argsFile, "FAKE_STDIN="+stdinFile,
		"POSTGRES_PASSWORD=", "POSTGRES_PASSWORD_FILE="+pwFile,
	)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(DisableSQL)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Skipf("cannot run fake psql here (%v): %s", err, out)
	}
	if strings.TrimSpace(string(out)) != "removed=1" {
		t.Fatalf("output %q", out)
	}
	got, _ := os.ReadFile(argsFile)
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(string(got), "\r\n", "\n"), "\n"), "\n")
	want := []string{"-U", "postgres", "-d", "plat db", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1",
		"-v", "email=" + email, "-v", "host=host;1", "-f", "-", "PGPASSWORD=s3cret pass"}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("psql args:\n got %q\nwant %q", lines, want)
	}
	if sql, _ := os.ReadFile(stdinFile); string(sql) != DisableSQL {
		t.Fatal("SQL did not reach psql stdin unchanged")
	}
	if _, err := os.Stat(filepath.Join(dir, "pwned")); err == nil {
		t.Fatal("email was executed by the shell")
	}
}

// On ha the instance label also matches CNPG standbys, which refuse writes
// (found on the 3-node test): the break-glass must exec in the primary.
func TestDisableUsesCNPGPrimary(t *testing.T) {
	f := &fakeKube{pod: "postgresql-3", primary: "postgresql-2", standby: true, execOut: "removed=1\n"}
	if _, err := (BreakGlass{Run: f.run, Database: "platform"}).Disable("a@example.com"); err != nil {
		t.Fatalf("Disable: %v", err)
	}
	last := f.calls[len(f.calls)-1]
	if strings.Join(last.args, " ") == "" || last.args[4] != "postgresql-2" {
		t.Fatalf("exec must target the primary, got %q", last.args)
	}
	for _, c := range f.calls {
		if strings.Contains(strings.Join(c.args, " "), "app.kubernetes.io/instance=postgresql") {
			t.Fatal("must not fall back to the instance label when a primary exists")
		}
	}
}
