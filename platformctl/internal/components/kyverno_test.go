package components

import (
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestKyvernoPolicyMode(t *testing.T) {
	if got := kyvernoPolicyMode(&config.Config{KyvernoPolicyMode: "Enforce"}); got != "Enforce" {
		t.Fatalf("got %q", got)
	}
	if got := kyvernoPolicyMode(&config.Config{}); got != "Audit" {
		t.Fatalf("default Audit, got %q", got)
	}
	t.Setenv("KYVERNO_POLICY_MODE", "enforce")
	if got := kyvernoPolicyMode(&config.Config{}); got != "Enforce" {
		t.Fatalf("env enforce → Enforce, got %q", got)
	}
}

func TestInstallKyvernoSkippedWhenDisabled(t *testing.T) {
	if err := InstallKyverno(&config.Config{InstallKyverno: false}); err != nil {
		t.Fatal(err)
	}
}

// Regression: Kyverno rejects mutateDigest=true unless the policy enforces,
// so the default (Audit) install failed to apply the policy.
func TestVerifyImagesPolicyMutatesDigestOnlyWhenEnforcing(t *testing.T) {
	raw := readManifest("kyverno-verify-images.yaml")
	for mode, want := range map[string]string{"Audit": "mutateDigest: false", "Enforce": "mutateDigest: true"} {
		got := renderVerifyImagesPolicy(raw, mode)
		if !strings.Contains(got, want) || !strings.Contains(got, "validationFailureAction: "+mode) || strings.Contains(got, "{{") {
			t.Fatalf("%s: rendered policy wrong:\n%s", mode, got)
		}
	}
}
