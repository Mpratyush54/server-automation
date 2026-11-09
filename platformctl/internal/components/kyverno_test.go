package components

import (
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
