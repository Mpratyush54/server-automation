package config

import "testing"

func TestSyntheticsBrowserOptInFullOnly(t *testing.T) {
	cases := []struct {
		profile, flag string
		want          bool
	}{
		{"full", "true", true},
		{"full", "", false},
		{"standard", "true", false},
		{"minimal", "true", false},
	}
	for _, tc := range cases {
		profileEnv(t, "")
		t.Setenv("PLATFORM_PROFILE", tc.profile)
		t.Setenv("SYNTHETICS_BROWSER", tc.flag)
		if got := Load().SyntheticsBrowser; got != tc.want {
			t.Fatalf("profile=%s SYNTHETICS_BROWSER=%q: got %v want %v", tc.profile, tc.flag, got, tc.want)
		}
	}
}
