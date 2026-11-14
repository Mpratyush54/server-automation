package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKEDAOptInAndSavedConfiguration(t *testing.T) {
	for _, profile := range Profiles {
		for _, enabled := range []string{"false", "true"} {
			profileEnv(t, "")
			t.Setenv("PLATFORM_PROFILE", profile)
			t.Setenv("INSTALL_KEDA", enabled)
			c := Load()
			want := enabled == "true" && FullFeatures(profile)
			if c.InstallKEDA != want {
				t.Fatalf("profile=%s INSTALL_KEDA=%s: got %v", profile, enabled, c.InstallKEDA)
			}
			path := filepath.Join(t.TempDir(), ".env")
			if err := c.SaveEnvFile(path); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			expected := "INSTALL_KEDA=false"
			if want {
				expected = "INSTALL_KEDA=true"
			}
			if !strings.Contains(string(b), expected) {
				t.Fatalf("missing %s", expected)
			}
		}
	}
}
