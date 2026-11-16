package cmd

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/license"
)

type licenseFake struct {
	log       string
	status    string
	published []license.Status
	auth      []k3s.ImageRegistryAuth
	restarts  int
}

func (f *licenseFake) calls(t *testing.T) string {
	t.Helper()
	b, _ := os.ReadFile(f.log)
	return string(b)
}

// stubLicense installs a fake client. codes maps a command to its exit code
// (default 0); creds is the registry-credentials output ("" = exit 1).
func stubLicense(t *testing.T, enforce bool, codes map[string]int, creds string) *licenseFake {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	dir := t.TempDir()
	f := &licenseFake{log: filepath.Join(dir, "calls.log"), status: filepath.Join(dir, "status.json")}
	logf := filepath.ToSlash(f.log)
	var cases strings.Builder
	for cmd, code := range codes {
		cases.WriteString("  " + cmd + ") code=" + itoa(code) + " ;;\n")
	}
	credsCase := "  registry-credentials) exit 1 ;;\n"
	if creds != "" {
		credsCase = "  registry-credentials) echo '" + creds + "'; exit 0 ;;\n"
	}
	script := "#!/usr/bin/env bash\necho \"$*\" >> '" + logf + "'\n" +
		"for a; do [ \"$a\" = - ] && { read -r k; echo \"stdin:$k\" >> '" + logf + "'; }; done\n" +
		"code=0\ncase \"$1\" in\n" + credsCase + cases.String() + "esac\n" +
		"echo '{\"command\":\"'$1'\",\"status\":\"x\",\"plan\":\"personal\",\"expires_at\":\"2027-01-01T00:00:00Z\"}'\nexit $code\n"
	src := filepath.Join(dir, "client")
	if err := os.WriteFile(src, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(dir, "lib", "cairn-license")

	oldInst, oldRun, oldPath, oldNodes, oldPub := licenseInstaller, licenseRunner, licenseStatusPath, licenseNodeCount, licensePublish
	oldAuth, oldRestart, oldK3s, oldInteractive, oldNow := licenseWriteRegistryAuth, licenseRestartK3s, licenseK3sInstalled, licenseInteractive, licenseNow
	oldEnforce, oldRegistry, oldKeyFile := cfg.LicenseEnforce, cfg.ImageRegistry, licenseKeyFile
	t.Cleanup(func() {
		licenseInstaller, licenseRunner, licenseStatusPath, licenseNodeCount, licensePublish = oldInst, oldRun, oldPath, oldNodes, oldPub
		licenseWriteRegistryAuth, licenseRestartK3s, licenseK3sInstalled, licenseInteractive, licenseNow = oldAuth, oldRestart, oldK3s, oldInteractive, oldNow
		cfg.LicenseEnforce, cfg.ImageRegistry, licenseKeyFile = oldEnforce, oldRegistry, oldKeyFile
	})
	licenseInstaller = func() license.Installer { return license.Installer{Override: src, Dest: dest} }
	licenseRunner = func(ctx context.Context, path string, args []string, stdin string) ([]byte, []byte, int, error) {
		c := exec.CommandContext(ctx, bash, append([]string{filepath.ToSlash(path)}, args...)...)
		c.Stdin = strings.NewReader(stdin)
		var out, errb bytes.Buffer
		c.Stdout, c.Stderr = &out, &errb
		err := c.Run()
		if ee, ok := err.(*exec.ExitError); ok {
			return out.Bytes(), errb.Bytes(), ee.ExitCode(), nil
		}
		return out.Bytes(), errb.Bytes(), 0, err
	}
	licenseStatusPath = f.status
	licenseNodeCount = func() int { return 2 }
	licensePublish = func(s license.Status) error { f.published = append(f.published, s); return nil }
	licenseWriteRegistryAuth = func(a k3s.ImageRegistryAuth) (bool, error) { f.auth = append(f.auth, a); return true, nil }
	licenseRestartK3s = func() error { f.restarts++; return nil }
	licenseK3sInstalled = func() bool { return true }
	licenseInteractive = func() bool { return false }
	licenseNow = func() time.Time { return time.Unix(0, 0) }
	licenseKeyFile = ""
	cfg.LicenseEnforce = enforce
	cfg.ImageRegistry = config.DefaultImageRegistry
	t.Setenv(license.EnvKey, "")
	return f
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	s := ""
	for ; n > 0; n /= 10 {
		s = string(rune('0'+n%10)) + s
	}
	return s
}

const testCreds = `{"registry":"registry.cairnpaas.dev","username":"u","password":"pw-secret"}`

func TestLicenseProvisionReportOnlyContinues(t *testing.T) {
	f := stubLicense(t, false, map[string]int{"verify": 30}, testCreds)
	var out bytes.Buffer
	if err := licenseProvision(&out, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "continuing") || cfg.ImageRegistry != config.DefaultImageRegistry || len(f.auth) != 0 {
		t.Fatalf("out=%q registry=%s auth=%v", out.String(), cfg.ImageRegistry, f.auth)
	}
	if strings.Contains(f.calls(t), "registry-credentials") {
		t.Fatal("registry credentials requested in report-only mode")
	}
	s, err := license.ReadStatus(f.status)
	if err != nil || s.ExitCode != 30 || s.Enforce {
		t.Fatalf("status %+v %v", s, err)
	}
}

func TestLicenseProvisionEnforcedRefuses(t *testing.T) {
	stubLicense(t, true, map[string]int{"activate": 20}, testCreds)
	t.Setenv(license.EnvKey, "cairn_key")
	if err := licenseProvision(&bytes.Buffer{}, false); err == nil {
		t.Fatal("invalid license accepted")
	}
}

func TestLicenseProvisionEnforcedSwitchesRegistry(t *testing.T) {
	f := stubLicense(t, true, nil, testCreds)
	t.Setenv(license.EnvKey, "cairn_key")
	var out bytes.Buffer
	if err := licenseProvision(&out, false); err != nil {
		t.Fatal(err)
	}
	calls := f.calls(t)
	if !strings.Contains(calls, "activate --version") || !strings.Contains(calls, "--nodes 1 --key -") || !strings.Contains(calls, "stdin:cairn_key") {
		t.Fatalf("calls:\n%s", calls)
	}
	if cfg.ImageRegistry != config.LicensedImageRegistry || len(f.auth) != 1 || f.auth[0].Password != "pw-secret" {
		t.Fatalf("registry=%s auth=%v", cfg.ImageRegistry, f.auth)
	}
	if f.restarts != 0 {
		t.Fatal("provision restarted k3s")
	}
	if strings.Contains(out.String(), "pw-secret") {
		t.Fatal("credentials in output")
	}
}

func TestLicenseProvisionOfflineKeepsBundleRegistry(t *testing.T) {
	f := stubLicense(t, true, nil, testCreds)
	if err := licenseProvision(&bytes.Buffer{}, true); err != nil {
		t.Fatal(err)
	}
	if cfg.ImageRegistry != config.DefaultImageRegistry || len(f.auth) != 0 {
		t.Fatal("offline install switched registry")
	}
}

func TestLicenseProvisionMissingCredentialsWhenEnforced(t *testing.T) {
	stubLicense(t, true, nil, "")
	err := licenseProvision(&bytes.Buffer{}, false)
	if err == nil || strings.Contains(err.Error(), "pw-secret") {
		t.Fatalf("err = %v", err)
	}
}

func TestLicenseClientUnavailable(t *testing.T) {
	stubLicense(t, false, nil, "")
	licenseInstaller = func() license.Installer { return license.Installer{Dest: filepath.Join(t.TempDir(), "c")} }
	if err := licenseProvision(&bytes.Buffer{}, false); err != nil {
		t.Fatalf("report-only: %v", err)
	}
	cfg.LicenseEnforce = true
	if err := licenseProvision(&bytes.Buffer{}, false); err == nil {
		t.Fatal("enforced without client")
	}
}

func TestLicenseUpgradeFallsBackAndRefreshesRegistry(t *testing.T) {
	f := stubLicense(t, true, map[string]int{"activate": 1}, testCreds)
	t.Setenv(license.EnvKey, "cairn_key")
	if err := licenseUpgrade(&bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if calls := f.calls(t); !strings.Contains(calls, "verify --nodes 2") {
		t.Fatalf("calls:\n%s", calls)
	}
	if f.restarts != 1 || len(f.published) != 1 {
		t.Fatalf("restarts=%d published=%d", f.restarts, len(f.published))
	}
}

func TestLicenseRefreshNeverFails(t *testing.T) {
	f := stubLicense(t, true, map[string]int{"checkin": 20}, "")
	if _, err := licenseClient(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := runLicenseRefresh(&bytes.Buffer{}); err != nil {
		t.Fatal(err)
	}
	if len(f.published) != 1 || f.published[0].ExitCode != 20 {
		t.Fatalf("published %+v", f.published)
	}
}

func TestLicenseNodeCheck(t *testing.T) {
	stubLicense(t, true, map[string]int{"verify": 21}, "")
	oldRole := joinedRole
	t.Cleanup(func() { joinedRole = oldRole })
	joinedRole = func() string { return "" }
	if _, err := licenseClient(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if err := licenseNodeCheck(&bytes.Buffer{}, 4); err == nil {
		t.Fatal("node limit accepted")
	}
	cfg.LicenseEnforce = false
	if err := licenseNodeCheck(&bytes.Buffer{}, 4); err != nil {
		t.Fatal(err)
	}
}

func TestLicenseUnits(t *testing.T) {
	service, timer := licenseUnits("/usr/local/bin/platformctl")
	if !strings.Contains(service, "ExecStart=/usr/local/bin/platformctl license refresh --auto") ||
		!strings.Contains(timer, "OnCalendar=weekly") || !strings.Contains(timer, "WantedBy=timers.target") {
		t.Fatalf("units:\n%s\n%s", service, timer)
	}
}

func TestRegistryAuthHandoff(t *testing.T) {
	oldRead, oldStore := licenseReadRegistryAuth, licenseStoreRegistryAuth
	t.Cleanup(func() { licenseReadRegistryAuth, licenseStoreRegistryAuth = oldRead, oldStore })
	want := k3s.ImageRegistryAuth{Registry: "registry.cairnpaas.dev", Username: "u", Password: "p"}
	licenseReadRegistryAuth = func() (k3s.ImageRegistryAuth, bool) { return want, true }
	var stored k3s.ImageRegistryAuth
	licenseStoreRegistryAuth = func(a k3s.ImageRegistryAuth) error { stored = a; return nil }
	p := filepath.Join(t.TempDir(), "auth.json")
	var stderr bytes.Buffer
	if err := writeRegistryAuth(&stderr, p); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stderr.String(), `"p"`) {
		t.Fatal("credentials printed")
	}
	if err := readRegistryAuth(p); err != nil || stored != want {
		t.Fatalf("stored %+v %v", stored, err)
	}
	if err := writeRegistryAuth(&stderr, ""); err != nil {
		t.Fatal(err)
	}
}
