package config

import "testing"

func TestSourceBuildsRequireOptInAndSupportedProfile(t *testing.T) {
	for _, profile := range Profiles {
		profileEnv(t, "")
		t.Setenv("PLATFORM_PROFILE", profile)
		t.Setenv("BUILDS_ENABLED", "true")
		c := Load()
		if c.BuildsEnabled != (profile != ProfileMinimal) {
			t.Fatalf("profile %s gate incorrect", profile)
		}
		t.Setenv("BUILDS_ENABLED", "false")
		if Load().BuildsEnabled {
			t.Fatal("builds enabled without opt-in")
		}
	}
}
