package license

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeClient writes a shell script that logs its arguments and stdin, prints
// out and exits with code.
func fakeClient(t *testing.T, out string, code int) (*Client, string) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	dir := t.TempDir()
	logf := filepath.Join(dir, "calls.log")
	script := filepath.Join(dir, "cairn-license")
	body := "#!/usr/bin/env bash\n" +
		"echo \"$*\" >> '" + filepath.ToSlash(logf) + "'\n" +
		"if [ \"$3\" = - ] || [ \"${*: -1}\" = - ]; then read -r k; echo \"stdin:$k\" >> '" + filepath.ToSlash(logf) + "'; fi\n" +
		"cat <<'JSON'\n" + out + "\nJSON\n" +
		"exit " + strconv.Itoa(code) + "\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	c := &Client{Path: script, Run: func(ctx context.Context, path string, args []string, stdin string) ([]byte, []byte, int, error) {
		return execRunner(ctx, bash, append([]string{filepath.ToSlash(path)}, args...), stdin)
	}}
	return c, logf
}

func itoa(n int) string { return strings.TrimSpace(strings.Repeat(" ", 0) + fmtInt(n)) }

func fmtInt(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func readLog(t *testing.T, p string) string {
	t.Helper()
	b, _ := os.ReadFile(p)
	return string(b)
}

func TestActivateWithKeyValueUsesStdin(t *testing.T) {
	c, logf := fakeClient(t, `{"command":"activate","status":"valid","exit_code":0,"allow_provision":true,"plan":"personal","max_nodes":3}`, 0)
	r, err := c.Activate(context.Background(), Fingerprint{Version: "1.2.3", Profile: "ha", Nodes: 2}, Key{Value: " cairn_abc "})
	if err != nil {
		t.Fatal(err)
	}
	if r.ExitCode != 0 || !r.AllowProvision || r.Plan != "personal" || r.MaxNodes == nil || *r.MaxNodes != 3 {
		t.Fatalf("report = %+v", r)
	}
	log := readLog(t, logf)
	if !strings.Contains(log, "activate --version 1.2.3 --profile ha --nodes 2 --key -") || !strings.Contains(log, "stdin:cairn_abc") {
		t.Fatalf("calls:\n%s", log)
	}
}

func TestActivateWithKeyFile(t *testing.T) {
	c, logf := fakeClient(t, `{"command":"activate","status":"invalid","exit_code":20,"allow_provision":false}`, 20)
	r, err := c.Activate(context.Background(), Fingerprint{}, Key{File: "/root/key"})
	if err != nil {
		t.Fatal(err)
	}
	if r.ExitCode != 20 || r.AllowProvision {
		t.Fatalf("report = %+v", r)
	}
	if log := readLog(t, logf); !strings.Contains(log, "activate --version dev --profile standard --nodes 1 --key-file /root/key") {
		t.Fatalf("calls:\n%s", log)
	}
}

func TestExitCodeWinsOverJSON(t *testing.T) {
	c, _ := fakeClient(t, `{"command":"verify","status":"valid","exit_code":0,"allow_provision":true}`, 21)
	r, err := c.Verify(context.Background(), 4)
	if err != nil {
		t.Fatal(err)
	}
	if r.ExitCode != 21 || r.AllowProvision {
		t.Fatalf("report = %+v", r)
	}
}

func TestUnparsableOutput(t *testing.T) {
	c, _ := fakeClient(t, `not json`, 1)
	r, err := c.Verify(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if r.ExitCode != 1 || r.Status != "error" || r.Command != "verify" {
		t.Fatalf("report = %+v", r)
	}
}

func TestUpgradeFallsBackToVerify(t *testing.T) {
	c, logf := fakeClient(t, `{"command":"x","status":"unreachable","exit_code":1,"allow_provision":false}`, 1)
	if _, err := c.Upgrade(context.Background(), Fingerprint{Nodes: 3}, Key{Value: "k"}); err != nil {
		t.Fatal(err)
	}
	log := readLog(t, logf)
	if !strings.Contains(log, "activate ") || !strings.Contains(log, "verify --nodes 3") {
		t.Fatalf("calls:\n%s", log)
	}
}

func TestUpgradeWithoutKeyOnlyVerifies(t *testing.T) {
	c, logf := fakeClient(t, `{"command":"verify","status":"valid","exit_code":0,"allow_provision":true}`, 0)
	if _, err := c.Upgrade(context.Background(), Fingerprint{Nodes: 1}, Key{}); err != nil {
		t.Fatal(err)
	}
	if log := readLog(t, logf); strings.Contains(log, "activate") || !strings.Contains(log, "verify --nodes 1") {
		t.Fatalf("calls:\n%s", log)
	}
}

func TestDecide(t *testing.T) {
	for _, tc := range []struct {
		code             int
		enforce, proceed bool
	}{
		{0, true, true}, {10, true, true}, {20, true, false}, {21, true, false}, {30, true, false}, {1, true, false}, {2, true, false},
		{0, false, true}, {20, false, true}, {30, false, true}, {1, false, true},
	} {
		r := Report{ExitCode: tc.code, AllowProvision: tc.code == 0 || tc.code == 10, Reason: "x"}
		d := Decide(r, tc.enforce)
		if d.Proceed != tc.proceed || d.Warn != (tc.code != 0) || d.Message == "" || strings.Contains(d.Message, "%!") {
			t.Errorf("code %d enforce %v: %+v", tc.code, tc.enforce, d)
		}
	}
}

func TestStatusFileAndConfigMap(t *testing.T) {
	p := filepath.Join(t.TempDir(), "status.json")
	n := 3
	s := NewStatus(Report{Command: "checkin", Status: "valid", Plan: "personal", InstallID: "ins_1", File: "/f", MaxNodes: &n}, true, time.Unix(0, 0))
	if err := WriteStatus(p, s); err != nil {
		t.Fatal(err)
	}
	got, err := ReadStatus(p)
	if err != nil || got.InstallID != "ins_1" || !got.Enforce || got.UpdatedAt != "1970-01-01T00:00:00Z" {
		t.Fatalf("got %+v, %v", got, err)
	}
	cm, err := ConfigMap(got)
	if err != nil {
		t.Fatal(err)
	}
	data := cm["data"].(map[string]string)[ConfigMapKey]
	if strings.Contains(data, "ins_1") || !strings.Contains(data, `"plan":"personal"`) || !strings.Contains(data, `"enforce":true`) {
		t.Fatalf("configmap data %s", data)
	}
	if sum := got.Summary(); !strings.Contains(sum, "plan personal") || !strings.Contains(sum, "enforced") {
		t.Fatalf("summary %q", sum)
	}
}

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestEnsureRefusesWithoutPinOrOverride(t *testing.T) {
	_, err := Installer{Dest: filepath.Join(t.TempDir(), "c")}.Ensure(context.Background())
	if !errors.Is(err, ErrNotPinned) {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureInstallsOverride(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "local")
	os.WriteFile(src, []byte("bin"), 0o755)
	dest := filepath.Join(dir, "lib", "cairn-license")
	got, err := Installer{Dest: dest, Override: src}.Ensure(context.Background())
	if err != nil || got != dest {
		t.Fatalf("%s %v", got, err)
	}
	if b, _ := os.ReadFile(dest); string(b) != "bin" {
		t.Fatalf("dest = %q", b)
	}
	if _, err := (Installer{Dest: dest, Override: "relative"}).Ensure(context.Background()); err == nil {
		t.Fatal("relative override accepted")
	}
}

func testServer(t *testing.T, files map[string][]byte) *httptest.Server {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := files[strings.TrimPrefix(r.URL.Path, "/v1.0.0/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEnsureDownloadsAndVerifiesChecksum(t *testing.T) {
	bin := []byte("client-binary")
	srv := testServer(t, map[string][]byte{"cairn-license-linux-amd64": bin})
	dest := filepath.Join(t.TempDir(), "cairn-license")
	in := Installer{Version: "v1.0.0", SHA256: map[string]string{"amd64": sha(bin)}, BaseURL: srv.URL, Arch: "amd64", Dest: dest, HTTP: srv.Client()}
	if _, err := in.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dest); string(b) != string(bin) {
		t.Fatalf("installed %q", b)
	}
	in.SHA256 = map[string]string{"amd64": sha([]byte("other"))}
	os.Remove(dest)
	if _, err := in.Ensure(context.Background()); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v", err)
	}
	if _, err := os.Stat(dest); err == nil {
		t.Fatal("mismatched binary installed")
	}
	in.BaseURL = "http://example.com"
	if _, err := in.Ensure(context.Background()); err == nil {
		t.Fatal("plain http accepted")
	}
}

func TestEnsureChecksSignedSums(t *testing.T) {
	bin := []byte("client-binary")
	srv := testServer(t, map[string][]byte{
		"cairn-license-linux-amd64": bin,
		"SHA256SUMS":                []byte(sha(bin) + "  cairn-license-linux-amd64\n"),
		"SHA256SUMS.sig":            []byte("sig"),
		"SHA256SUMS.pem":            []byte("pem"),
	})
	dest := filepath.Join(t.TempDir(), "cairn-license")
	verified := 0
	in := Installer{Version: "v1.0.0", SHA256: map[string]string{"amd64": sha(bin)}, BaseURL: srv.URL, Arch: "amd64", Dest: dest, HTTP: srv.Client(),
		Cosign: func(_ context.Context, sums, sig, cert string) error { verified++; return nil }}
	if _, err := in.Ensure(context.Background()); err != nil || verified != 1 {
		t.Fatalf("err=%v verified=%d", err, verified)
	}
	os.Remove(dest)
	in.Cosign = func(context.Context, string, string, string) error { return errors.New("bad signature") }
	if _, err := in.Ensure(context.Background()); err == nil {
		t.Fatal("bad signature accepted")
	}
}

func TestEnsureUsesStagedBinary(t *testing.T) {
	dir := t.TempDir()
	bin := []byte("staged")
	staged := filepath.Join(dir, "staged")
	os.WriteFile(staged, bin, 0o755)
	dest := filepath.Join(dir, "cairn-license")
	in := Installer{Version: "v1.0.0", SHA256: map[string]string{"amd64": sha(bin)}, BaseURL: "https://invalid.invalid", Arch: "amd64", Dest: dest, Staged: staged}
	if _, err := in.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestRegistryCredentials(t *testing.T) {
	c, logf := fakeClient(t, `{"registry":"registry.cairnpaas.dev","username":"u","password":"s3cret"}`, 0)
	rc, err := c.RegistryCredentials(context.Background())
	if err != nil || rc.Registry != "registry.cairnpaas.dev" || rc.Password != "s3cret" {
		t.Fatalf("%+v %v", rc, err)
	}
	if !strings.Contains(readLog(t, logf), "registry-credentials") {
		t.Fatal("command not run")
	}
	bad, _ := fakeClient(t, `{"registry":"r","username":"u","password":"s3cret"}`, 2)
	if _, err := bad.RegistryCredentials(context.Background()); err == nil || strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("err = %v", err)
	}
	empty, _ := fakeClient(t, `{"registry":"r"}`, 0)
	if _, err := empty.RegistryCredentials(context.Background()); err == nil {
		t.Fatal("empty credentials accepted")
	}
}
