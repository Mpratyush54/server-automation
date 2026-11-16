package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveEnvFileLicenseSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	c := &Config{ImageRegistry: DefaultImageRegistry, Diagnostics: true}
	if err := c.SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	for _, key := range []string{"PLATFORM_LICENSE_ENFORCE", "PLATFORM_DIAGNOSTICS", "PLATFORM_IMAGE_REGISTRY", "CAIRN_LICENSE_KEY"} {
		if strings.Contains(string(b), key) {
			t.Fatalf("default install writes %s", key)
		}
	}
	c = &Config{ImageRegistry: LicensedImageRegistry, LicenseEnforce: true}
	old := dotenvLoaded["CAIRN_LICENSE_KEY"]
	dotenvLoaded["CAIRN_LICENSE_KEY"] = "cairn_from_env_file"
	t.Cleanup(func() { dotenvLoaded["CAIRN_LICENSE_KEY"] = old })
	if err := c.SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	for _, line := range []string{"PLATFORM_LICENSE_ENFORCE=true\n", "PLATFORM_DIAGNOSTICS=off\n", "PLATFORM_IMAGE_REGISTRY=" + LicensedImageRegistry + "\n", "CAIRN_LICENSE_KEY=cairn_from_env_file\n"} {
		if !strings.Contains(string(b), line) {
			t.Fatalf("missing %q in:\n%s", line, b)
		}
	}
}

func TestDiagnosticsEnabled(t *testing.T) {
	for v, want := range map[string]bool{"": true, "on": true, "off": false, "False": false, "0": false} {
		if diagnosticsEnabled(v) != want {
			t.Errorf("%q", v)
		}
	}
}
