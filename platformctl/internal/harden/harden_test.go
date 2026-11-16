package harden

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func loginKey(t *testing.T) string {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return string(ssh.MarshalAuthorizedKey(key))
}

func TestHasKey(t *testing.T) {
	key := loginKey(t)
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"", false}, {"# " + key, false}, {"ssh-ed25519 broken", false},
		{key, true}, {"# comment\n\n" + key + "\n", true},
		{"command=\"backup\" " + key, false}, {"from=\"localhost\" " + key, false},
	} {
		if got := HasKey([]byte(tc.text)); got != tc.want {
			t.Errorf("HasKey(%q)=%v", tc.text, got)
		}
	}
}

func TestConfig(t *testing.T) {
	for _, s := range []string{"PermitRootLogin prohibit-password", "PasswordAuthentication no", "KbdInteractiveAuthentication no"} {
		if !strings.Contains(SSHConfig(true), s) {
			t.Error(s)
		}
		if strings.Contains(SSHConfig(false), s) {
			t.Errorf("unsafe without key: %s", s)
		}
	}
	for _, s := range []string{"[sshd]", "backend = systemd", "nftables-multiport"} {
		if !strings.Contains(Fail2banConfig(), s) {
			t.Error(s)
		}
	}
	if !strings.Contains(UpdatesConfig, "Automatic-Reboot \"false\"") || strings.Contains(UpdatesConfig, "-updates\"") {
		t.Fatal("update policy")
	}
	if !strings.Contains(NginxAuthJail, "ingress-error.log") {
		t.Fatal("missing nginx log")
	}
	cidrs, err := CIDRs(nil)
	if err != nil {
		t.Fatal(err)
	}
	rules := Firewall(cidrs)
	for _, s := range []string{"priority 10", "policy drop", "ct state established,related", "iifname \"lo\"", "22, 80, 443", "cni0", "flannel.*", "10.42.0.0/16", "10.43.0.0/16", "ct original proto-dst { 80, 443 }"} {
		if !strings.Contains(rules, s) {
			t.Error(s)
		}
	}
	for _, s := range []string{"flush ruleset", "6443", "10250", "0.0.0.0/0"} {
		if strings.Contains(rules, s) {
			t.Error("unsafe rule", s)
		}
	}
}

func TestCIDRs(t *testing.T) {
	for _, config := range []string{
		"cluster-cidr: '10.44.0.0/16'\nservice-cidr: 10.45.0.0/16 # test",
		"cluster-cidr: [\"10.44.0.0/16\", 'fd00:42::/56']\nservice-cidr:\n  - 10.45.0.0/16\n  - fd00:43::/112",
	} {
		p, err := CIDRs([]byte(config))
		if err != nil {
			t.Fatal(err)
		}
		if p[0].String() != "10.44.0.0/16" {
			t.Fatal(p)
		}
		if len(p) == 4 && !strings.Contains(Firewall(p), "ip6 saddr fd00:42::/56") {
			t.Fatal("dual stack")
		}
	}
	if _, err := CIDRs([]byte("cluster-cidr: bad; injected")); err == nil {
		t.Fatal("accepted malformed CIDR")
	}
}

type fake struct {
	calls     []string
	fail      string
	prior     string
	effective string
	active    string
	h         *Host
}

func (f *fake) run(name string, args ...string) (string, error) {
	s := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, s)
	if f.fail != "" && strings.HasPrefix(s, f.fail) {
		return "test failure", errors.New("failed")
	}
	if s == "nft list table inet platform_guard" {
		if f.prior == "" {
			return "", errors.New("absent")
		}
		return f.prior, nil
	}
	if s == "sshd -T" {
		return f.effective, nil
	}
	if strings.HasPrefix(s, "systemctl is-active ") {
		return f.active, nil
	}
	if name == "sh" {
		_ = os.Remove(f.h.Path(runtimeDir + "/pending"))
	}
	return "", nil
}
func testHost(t *testing.T) (Host, *fake) {
	t.Helper()
	f := &fake{effective: "passwordauthentication no\nkbdinteractiveauthentication no\npubkeyauthentication yes\npermitrootlogin without-password"}
	h := Host{Root: t.TempDir(), KeyFiles: []string{"/root/.ssh/authorized_keys"}, Run: f.run}
	f.h = &h
	return h, f
}

func TestSSHGuardAndValidation(t *testing.T) {
	for _, fail := range []string{"no key", "sshd -t", "sshd -T", "effective", "systemctl try-reload-or-restart ssh", ""} {
		t.Run(fail, func(t *testing.T) {
			h, f := testHost(t)
			warned := false
			h.Warn = func(string) { warned = true }
			if fail != "no key" {
				if err := h.write(h.KeyFiles[0], loginKey(t), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if fail == "effective" {
				f.effective = "passwordauthentication yes"
			} else if fail != "no key" {
				f.fail = fail
			}
			err := h.SSH()
			if fail == "no key" {
				if err != nil || !warned || len(f.calls) != 0 {
					t.Fatal("no-key guard", err, f.calls)
				}
				return
			}
			_, existsErr := h.read(SSHPath)
			if fail == "" {
				if err != nil || existsErr != nil {
					t.Fatal(err, existsErr)
				}
			} else {
				if err == nil || !os.IsNotExist(existsErr) {
					t.Fatal("did not remove invalid drop-in", err, existsErr)
				}
				if fail != "systemctl reload ssh" && strings.Contains(strings.Join(f.calls, "\n"), "systemctl reload") {
					t.Fatal("reloaded invalid config")
				}
			}
		})
	}
}

func TestSSHRestoresPreviousDropin(t *testing.T) {
	h, f := testHost(t)
	_ = h.write(h.KeyFiles[0], loginKey(t), 0600)
	_ = h.write(SSHPath, "# prior\n", 0644)
	f.fail = "sshd -t"
	if h.SSH() == nil {
		t.Fatal("expected failure")
	}
	data, _ := h.read(SSHPath)
	if string(data) != "# prior\n" {
		t.Fatal("prior lost")
	}
}

func TestCustomSSHAuthenticationGuard(t *testing.T) {
	for _, setting := range []string{"authorizedkeysfile /custom/keys", "authenticationmethods publickey,password", "authenticationmethods publickey,keyboard-interactive", "authenticationmethods publickey,publickey"} {
		h, f := testHost(t)
		_ = h.write(h.KeyFiles[0], loginKey(t), 0600)
		f.effective += "\n" + setting
		if h.SSH() == nil {
			t.Fatalf("unsafe config accepted: %s", setting)
		}
	}
}

func TestKeyPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission semantics")
	}
	h, _ := testHost(t)
	_ = h.write(h.KeyFiles[0], loginKey(t), 0600)
	if !h.HasLoginKey() {
		t.Fatal("secure key rejected")
	}
	if err := os.Chmod(h.Path(h.KeyFiles[0]), 0666); err != nil {
		t.Fatal(err)
	}
	if h.HasLoginKey() {
		t.Fatal("world-writable key accepted")
	}
}

func TestOptionalNginxJailAndClockFailure(t *testing.T) {
	h, f := testHost(t)
	h.NginxAuth = true
	if h.Prepare() == nil || len(f.calls) != 0 {
		t.Fatal("missing log should fail before any host changes")
	}
	_ = h.write("/var/log/platform/ingress-error.log", "", 0600)
	if err := h.Prepare(); err != nil {
		t.Fatal(err)
	}
	jail, _ := h.read("/etc/fail2ban/jail.d/60-platform-nginx.local")
	if string(jail) != NginxAuthJail {
		t.Fatal("optional jail not enabled")
	}
	// An unsynchronised clock warns but does not fail the install (NTP may be
	// blocked; chrony keeps trying).
	f.fail = "chronyc waitsync"
	var warned []string
	h.Warn = func(s string) { warned = append(warned, s) }
	if err := h.Prepare(); err != nil {
		t.Fatalf("unsynced clock must only warn, got %v", err)
	}
	if len(warned) == 0 || !strings.Contains(strings.Join(warned, " "), "clock not synchronised") {
		t.Fatalf("expected a clock warning, got %q", warned)
	}
}

// Some OpenSSH builds print prohibit-password, others without-password.
func TestSSHAcceptsBothRootLoginSpellings(t *testing.T) {
	for _, spelling := range []string{"without-password", "prohibit-password"} {
		h, f := testHost(t)
		f.effective = "passwordauthentication no\nkbdinteractiveauthentication no\npubkeyauthentication yes\npermitrootlogin " + spelling
		if err := h.write(h.KeyFiles[0], loginKey(t), 0600); err != nil {
			t.Fatal(err)
		}
		if err := h.SSH(); err != nil {
			t.Fatalf("%s: %v", spelling, err)
		}
		if !strings.Contains(strings.Join(f.calls, "\n"), "systemctl try-reload-or-restart ssh") {
			t.Fatalf("%s: expected try-reload-or-restart (socket-activated ssh), calls %v", spelling, f.calls)
		}
	}
}

func TestFirewallTransaction(t *testing.T) {
	for _, tc := range []struct {
		name, fail       string
		confirm, success bool
	}{
		{"confirmed", "", true, true}, {"rejected", "", false, false},
		{"syntax", "nft -c", true, false}, {"timer", "systemd-run", true, false},
		{"apply", "nft -f", true, false}, {"cancel", "systemctl stop", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, f := testHost(t)
			f.fail = tc.fail
			err := h.ApplyFirewall(func() bool { return tc.confirm })
			if (err == nil) != tc.success {
				t.Fatal(err)
			}
			calls := strings.Join(f.calls, "\n")
			i := strings.Index(calls, "nft -f ")
			timer := strings.Index(calls, "systemd-run")
			if i >= 0 && (timer < 0 || timer > i) {
				t.Fatal("policy applied before rollback armed")
			}
			_, stat := h.read("/etc/platform/firewall.nft")
			if !tc.success && !os.IsNotExist(stat) {
				t.Fatal("unconfirmed policy persisted")
			}
			if tc.name == "rejected" && !strings.Contains(calls, "sh ") {
				t.Fatal("no immediate rollback")
			}
		})
	}
}

func TestFirewallExpiredAndRollbackFailure(t *testing.T) {
	h, f := testHost(t)
	if err := h.ApplyFirewall(func() bool { _ = os.Remove(h.Path(runtimeDir + "/pending")); return true }); err == nil {
		t.Fatal("accepted expired transaction")
	}
	h, f = testHost(t)
	f.fail = "sh "
	if h.ApplyFirewall(func() bool { return false }) == nil {
		t.Fatal("rollback failed silently")
	}
	if strings.Contains(strings.Join(f.calls, "\n"), "systemctl stop") {
		t.Fatal("cancelled backup timer after rollback failure")
	}
	if h.ApplyFirewall(func() bool { return true }) == nil {
		t.Fatal("overwrote pending transaction")
	}
}

func TestIdempotency(t *testing.T) {
	h, f := testHost(t)
	if err := h.Prepare(); err != nil {
		t.Fatal(err)
	}
	data, _ := h.read("/etc/fail2ban/jail.d/60-platform.local")
	info, _ := os.Stat(h.Path("/etc/fail2ban/jail.d/60-platform.local"))
	if err := h.Prepare(); err != nil {
		t.Fatal(err)
	}
	data2, _ := h.read("/etc/fail2ban/jail.d/60-platform.local")
	info2, _ := os.Stat(h.Path("/etc/fail2ban/jail.d/60-platform.local"))
	if !reflect.DeepEqual(data, data2) || info.ModTime() != info2.ModTime() {
		t.Fatal("unchanged config rewritten")
	}
	if err := h.ApplyFirewall(func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	f.prior = Firewall(mustCIDRs(t))
	if err := h.ApplyFirewall(func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	rollback, _ := h.read(runtimeDir + "/rollback.nft")
	if !strings.Contains(string(rollback), f.prior) {
		t.Fatal("previous policy not backed up")
	}
}

func mustCIDRs(t *testing.T) []netip.Prefix {
	t.Helper()
	p, err := CIDRs(nil)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRollbackShellQuoting(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	h := Host{Root: filepath.ToSlash(filepath.Join(t.TempDir(), "space and 'quote"))}
	_ = h.write(runtimeDir+"/pending", "pending", 0600)
	// Override nft as a function: execute the generated rollback with no host commands.
	script := "nft() { case \"$1\" in list|add) return 0;; -f) [ \"$2\" = " + Quote(filepath.ToSlash(h.Path(runtimeDir+"/rollback.nft"))) + " ] || return 2;; *) return 1;; esac; }\n" + strings.TrimPrefix(h.RollbackScript(), "#!/bin/sh\n")
	out, err := exec.Command(bash, "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if _, err := h.read(runtimeDir + "/pending"); !os.IsNotExist(err) {
		t.Fatal("rollback did not clear pending marker")
	}
}

func TestInterruptedFirewallRecovery(t *testing.T) {
	h, f := testHost(t)
	f.fail = "sh "
	if h.ApplyFirewall(func() bool { return false }) == nil {
		t.Fatal("expected rollback failure")
	}
	f.fail, f.active = "", "inactive"
	f.calls = nil
	if err := h.ApplyFirewall(func() bool { return true }); err != nil {
		t.Fatal(err)
	}
	calls := strings.Join(f.calls, "\n")
	if strings.Index(calls, "sh ") > strings.Index(calls, "nft -c") {
		t.Fatal("stale rollback overwritten before recovery")
	}
}

// A fresh node has empty apt lists: the first install fails, Prepare refreshes
// the lists once and retries (regression from the ha join test).
func TestPrepareRefreshesAptListsOnce(t *testing.T) {
	h, f := testHost(t)
	installs := 0
	h.Run = func(name string, args ...string) (string, error) {
		s := name + " " + strings.Join(args, " ")
		if strings.Contains(s, " install -y ") {
			if !strings.Contains(s, "DPkg::Lock::Timeout=") {
				t.Errorf("apt install must wait for the dpkg lock: %s", s)
			}
			installs++
			if installs == 1 {
				f.calls = append(f.calls, s)
				return "E: Unable to locate package fail2ban", errors.New("exit status 100")
			}
		}
		return f.run(name, args...)
	}
	f.h = &h
	if err := h.Prepare(); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	joined := strings.Join(f.calls, "\n")
	if installs != 2 || !strings.Contains(joined, " update -qq") {
		t.Fatalf("want install, update, install; got %d installs:\n%s", installs, joined)
	}
}
