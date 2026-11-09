package cmd

import (
	"io"
	"strings"
	"testing"
	"time"
)

func TestAutomaticFirewallConfirmation(t *testing.T) {
	for _, healthy := range []bool{true, false} {
		calls := 0
		if got := confirmFirewall(true, func() bool { calls++; return healthy }); got != healthy || calls != 1 {
			t.Fatal("auto confirmation bypassed health gate")
		}
	}
	if confirmFirewall(false, func() bool { return false }) {
		t.Fatal("interactive confirmation bypassed health gate")
	}
}

func TestInteractiveFirewallConfirmation(t *testing.T) {
	for _, answer := range []string{"confirm\n", "no\n", "", "yes\n"} {
		if got := confirmFirewallInput(false, func() bool { return true }, strings.NewReader(answer), time.Second); got != (answer == "confirm\n") {
			t.Fatalf("answer %q: %v", answer, got)
		}
	}
	r, w := io.Pipe()
	defer r.Close()
	defer w.Close()
	if confirmFirewallInput(false, func() bool { return true }, r, time.Millisecond) {
		t.Fatal("confirmed after timeout")
	}
}

func TestHardeningFlags(t *testing.T) {
	if provisionCmd.Flags().Lookup("skip-hardening") == nil || rootCmd.PersistentFlags().Lookup("waf") == nil || rootCmd.PersistentFlags().Lookup("nginx-auth-jail") == nil {
		t.Fatal("missing hardening flags")
	}
	if cmd, _, err := rootCmd.Find([]string{"harden"}); err != nil || cmd != hardenCmd {
		t.Fatal("missing harden command")
	}
}
