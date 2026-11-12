package cmd

import (
	"bytes"
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

// Provision on an already provisioned server applies host hardening: say so,
// and let an interactive operator decline.
func TestConfirmHardeningOnExistingServer(t *testing.T) {
	oldExisting, oldSkip := existingInstall, cfg.SkipHardening
	defer func() { existingInstall, cfg.SkipHardening = oldExisting, oldSkip }()
	existingInstall = func() bool { return true }

	cfg.SkipHardening = false
	var out bytes.Buffer
	confirmHardening(strings.NewReader(""), &out, false)
	if !strings.Contains(out.String(), "SKIP_HARDENING=true") || cfg.SkipHardening {
		t.Fatalf("non-interactive: %q skip=%v", out.String(), cfg.SkipHardening)
	}
	out.Reset()
	confirmHardening(strings.NewReader("n\n"), &out, true)
	if !cfg.SkipHardening {
		t.Fatal("interactive decline ignored")
	}
	cfg.SkipHardening = false
	confirmHardening(strings.NewReader("\n"), &out, true)
	if cfg.SkipHardening {
		t.Fatal("default answer must keep hardening")
	}
	existingInstall = func() bool { return false }
	out.Reset()
	confirmHardening(strings.NewReader(""), &out, true)
	if out.Len() != 0 {
		t.Fatal("fresh install must not prompt")
	}
}

// join over non-interactive SSH, or with the token piped on stdin, could never
// type 'confirm': the firewall was armed and rolled back after 90 s (3-node test).
func TestHardenFirewallNeedsTerminalOrAuto(t *testing.T) {
	oldTTY, oldAuto := stdinIsTerminal, cfg.NonInteractive
	defer func() { stdinIsTerminal, cfg.NonInteractive = oldTTY, oldAuto }()
	stdinIsTerminal = func() bool { return false }
	cfg.NonInteractive = false
	err := hardenFirewall()
	if err == nil || !strings.Contains(err.Error(), "--auto") {
		t.Fatalf("want a --auto hint before arming the firewall, got %v", err)
	}
}
