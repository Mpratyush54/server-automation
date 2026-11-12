package harden

import (
	"bytes"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Runner func(name string, args ...string) (string, error)

type Host struct {
	// Root is empty in production, a temp directory in tests.
	Root string
	Run  Runner
	// KeyFiles are root and SUDO_USER authorized_keys, resolved by the caller.
	KeyFiles  []string
	Warn      func(string)
	NginxAuth bool
	// APIVIP and NodeSubnet enable the optional control-plane VIP firewall rule
	// (ha profile with API_VIP). Both must be set for the rule to appear.
	APIVIP     netip.Addr
	NodeSubnet netip.Prefix
	// ClusterPeers are the PLATFORM_CLUSTER_NODES prefixes (ha, #53).
	ClusterPeers []netip.Prefix
}

func (h Host) Path(p string) string          { return filepath.Join(h.Root, filepath.FromSlash(p)) }
func (h Host) read(p string) ([]byte, error) { return os.ReadFile(h.Path(p)) }
func (h Host) write(p, data string, mode os.FileMode) error {
	old, readErr := h.read(p)
	if readErr == nil && bytes.Equal(old, []byte(data)) {
		return nil
	}
	path := h.Path(p)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", []byte(data), mode); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}
func (h Host) run(name string, args ...string) error {
	out, err := h.Run(name, args...)
	if err != nil {
		return fmt.Errorf("%s: %w: %s", name, err, out)
	}
	return nil
}
func (h Host) HasLoginKey() bool {
	for _, path := range h.KeyFiles {
		data, err := h.read(path)
		if err == nil && HasKey(data) && h.secureKeyPath(path) {
			return true
		}
	}
	return false
}

func (h Host) secureKeyPath(path string) bool {
	// Windows exposes synthetic 0777 directory modes; production is Linux.
	if runtime.GOOS == "windows" {
		return true
	}
	// sshd StrictModes rejects group/world-writable keys and home/.ssh dirs.
	for _, p := range []string{path, filepath.Dir(path), filepath.Dir(filepath.Dir(path))} {
		info, err := os.Stat(h.Path(p))
		if err != nil || info.Mode().Perm()&0022 != 0 {
			return false
		}
	}
	return true
}

func (h Host) Prepare() error {
	if h.NginxAuth {
		if _, err := h.read("/var/log/platform/ingress-error.log"); err != nil {
			return fmt.Errorf("nginx auth jail requires exported ingress error log: %w", err)
		}
	}
	if err := h.run("env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq", "unattended-upgrades", "fail2ban", "chrony", "nftables"); err != nil {
		return err
	}
	for p, data := range map[string]string{
		"/etc/apt/apt.conf.d/99-platform-security": UpdatesConfig,
		"/etc/apt/apt.conf.d/20auto-upgrades":      PeriodicConfig,
		"/etc/fail2ban/jail.d/60-platform.local":   Fail2banConfig(),
	} {
		if err := h.write(p, data, 0644); err != nil {
			return err
		}
	}
	if err := h.SSH(); err != nil {
		return err
	}
	jail := "# Optional nginx auth jail disabled\n"
	if h.NginxAuth {
		jail = NginxAuthJail
	}
	if err := h.write("/etc/fail2ban/jail.d/60-platform-nginx.local", jail, 0644); err != nil {
		return err
	}
	if err := h.run("fail2ban-client", "-t"); err != nil {
		return err
	}
	for _, service := range []string{"fail2ban", "chrony", "apt-daily.timer", "apt-daily-upgrade.timer"} {
		if err := h.run("systemctl", "enable", "--now", service); err != nil {
			return err
		}
	}
	if err := h.run("systemctl", "restart", "fail2ban"); err != nil {
		return err
	}
	// Bounded wait. An unsynchronised clock is reported loudly but does not fail
	// the install: networks that block NTP (UDP 123) are common, and chrony
	// keeps trying in the background. TOTP (#24) and TLS need a correct clock.
	if err := h.run("chronyc", "waitsync", "15", "0.1", "0", "2"); err != nil && h.Warn != nil {
		h.Warn("clock not synchronised yet (chrony keeps trying; check UDP 123 to your NTP servers): " + err.Error())
	}
	return nil
}

func (h Host) SSH() error {
	key := h.HasLoginKey()
	if !key {
		if h.Warn != nil {
			h.Warn("No unrestricted root/SUDO_USER authorized key: SSH password authentication will NOT be disabled. Add a login key and rerun platformctl harden.")
		}
		return nil
	}
	previous, err := h.read(SSHPath)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := h.write(SSHPath, SSHConfig(true), 0644); err != nil {
		return err
	}
	restore := func() {
		if previous == nil {
			_ = os.Remove(h.Path(SSHPath))
		} else {
			_ = h.write(SSHPath, string(previous), 0644)
		}
	}
	if err := h.run("sshd", "-t"); err != nil {
		restore()
		return err
	}
	// OpenSSH uses the first value, so a pre-existing cloud-init drop-in can
	// override ours. Never report success when password auth remains enabled.
	out, err := h.Run("sshd", "-T")
	if err != nil {
		restore()
		return err
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "authorizedkeysfile ") {
			found := false
			for _, path := range strings.Fields(line)[1:] {
				if path == ".ssh/authorized_keys" || path == "%h/.ssh/authorized_keys" {
					found = true
				}
			}
			if !found {
				restore()
				return fmt.Errorf("custom AuthorizedKeysFile requires operator-managed SSH configuration")
			}
		}
		if methods, ok := strings.CutPrefix(line, "authenticationmethods "); ok && methods != "any" && methods != "publickey" {
			restore()
			return fmt.Errorf("custom AuthenticationMethods requires operator-managed SSH configuration")
		}
	}
	effective := "\n" + strings.ReplaceAll(out, "\r", "") + "\n"
	for _, want := range []string{"passwordauthentication no", "kbdinteractiveauthentication no", "pubkeyauthentication yes"} {
		if !strings.Contains(effective, "\n"+want+"\n") {
			restore()
			return fmt.Errorf("effective sshd setting missing %q; review earlier sshd configuration", want)
		}
	}
	// `sshd -T` prints prohibit-password as "without-password" in some OpenSSH
	// builds and "prohibit-password" in others; both mean key-only root login.
	if !strings.Contains(effective, "\npermitrootlogin without-password\n") && !strings.Contains(effective, "\npermitrootlogin prohibit-password\n") {
		restore()
		return fmt.Errorf("effective sshd setting missing \"permitrootlogin prohibit-password\"; review earlier sshd configuration")
	}
	// Ubuntu 24.04 socket-activates ssh: ssh.service may not be running, and
	// `reload` then fails. try-reload-or-restart reloads a running daemon and
	// otherwise does nothing (the next start reads the new drop-in).
	if err := h.run("systemctl", "try-reload-or-restart", "ssh"); err != nil {
		restore()
		return err
	}
	return nil
}

const runtimeDir = "/var/lib/platform/harden"
const rollbackUnit = "platform-firewall-rollback"

func (h Host) RollbackScript() string {
	return "#!/bin/sh\nset -eu\nnft list table inet platform_guard >/dev/null 2>&1 || nft add table inet platform_guard\nnft -f " + Quote(filepath.ToSlash(h.Path(runtimeDir+"/rollback.nft"))) + "\nrm -f " + Quote(filepath.ToSlash(h.Path(runtimeDir+"/pending"))) + "\n"
}

// Firewall applies only our table in an atomic nft transaction. A systemd timer
// exists before any packet policy changes; no global iptables/nft flush occurs.
func (h Host) ApplyFirewall(confirm func() bool) error {
	if _, err := h.read(runtimeDir + "/pending"); err == nil {
		// Transient timers disappear after reboot. Recover a stale transaction
		// using its saved rollback instead of permanently blocking reconciliation.
		for _, unit := range []string{rollbackUnit + ".timer", rollbackUnit + ".service"} {
			active, _ := h.Run("systemctl", "is-active", unit)
			if s := strings.TrimSpace(active); s != "inactive" && s != "failed" {
				return fmt.Errorf("firewall transaction pending; wait for rollback before retrying")
			}
		}
		if err := h.run("sh", h.Path(runtimeDir+"/rollback.sh")); err != nil {
			return fmt.Errorf("recover interrupted firewall: %w", err)
		}
	}
	data, err := h.read("/etc/rancher/k3s/config.yaml")
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	// Fragments that override cluster/service CIDRs would make the firewall use
	// the wrong pod networks. Other drop-ins (e.g. ingress-HA disable+/tls-san+)
	// are allowed; CIDRs still come from the main config.yaml.
	if err := h.refuseCIDRFragments(); err != nil {
		return err
	}
	cidrs, err := CIDRs(data)
	if err != nil {
		return err
	}
	prior, listErr := h.Run("nft", "list", "table", "inet", "platform_guard")
	if listErr != nil {
		// Distinguish missing table from permission/kernel failures.
		if err := h.run("nft", "list", "tables"); err != nil {
			return err
		}
		prior = ""
	}
	// Ensure the table exists so delete+replace is valid both on first install
	// and reapply. An empty table cannot restrict any traffic.
	if prior == "" {
		if err := h.run("nft", "add", "table", "inet", "platform_guard"); err != nil {
			return err
		}
	}
	rules := FirewallWith(cidrs, FirewallOptions{APIVIP: h.APIVIP, NodeSubnet: h.NodeSubnet, Peers: h.ClusterPeers})
	apply := "delete table inet platform_guard\n" + rules
	rollback := "delete table inet platform_guard\n" + prior + "\n"
	persisted := map[string][]byte{}
	for _, path := range []string{"/etc/platform/firewall.nft", "/etc/systemd/system/platform-firewall.service"} {
		old, err := h.read(path)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		persisted[path] = old
	}
	for p, value := range map[string]string{
		runtimeDir + "/apply.nft":    apply,
		runtimeDir + "/rollback.nft": rollback,
		runtimeDir + "/rollback.sh":  h.RollbackScript(),
	} {
		if err := h.write(p, value, 0600); err != nil {
			return err
		}
	}
	if err := h.run("nft", "-c", "-f", h.Path(runtimeDir+"/apply.nft")); err != nil {
		return err
	}
	if err := h.write(runtimeDir+"/pending", "pending\n", 0600); err != nil {
		return err
	}
	if err := h.run("systemd-run", "--collect", "--unit="+rollbackUnit, "--on-active=120s", "--timer-property=AccuracySec=1s", "/bin/sh", h.Path(runtimeDir+"/rollback.sh")); err != nil {
		_ = os.Remove(h.Path(runtimeDir + "/pending"))
		return err
	}
	rollbackNow := func(cause error) error {
		// If rollback fails leave the independent timer armed.
		if err := h.run("sh", h.Path(runtimeDir+"/rollback.sh")); err != nil {
			return fmt.Errorf("%v; rollback: %w (timer remains armed)", cause, err)
		}
		for path, old := range persisted {
			if old == nil {
				if strings.HasSuffix(path, ".service") {
					_ = h.run("systemctl", "disable", "platform-firewall.service")
				}
				_ = os.Remove(h.Path(path))
			} else if err := h.write(path, string(old), 0600); err != nil {
				return fmt.Errorf("%v; restore persisted firewall: %w", cause, err)
			}
		}
		_ = h.run("systemctl", "daemon-reload")
		_ = h.run("systemctl", "stop", rollbackUnit+".timer")
		return cause
	}
	if err := h.run("nft", "-f", h.Path(runtimeDir+"/apply.nft")); err != nil {
		return rollbackNow(err)
	}
	if !confirm() {
		return rollbackNow(fmt.Errorf("firewall unconfirmed; previous policy restored"))
	}
	if err := h.run("systemctl", "stop", rollbackUnit+".timer"); err != nil {
		return rollbackNow(err)
	}
	// Never stop a running rollback halfway between its atomic nft transaction
	// and marker removal. If the timer fired concurrently, fail closed.
	active, _ := h.Run("systemctl", "is-active", rollbackUnit+".service")
	if s := strings.TrimSpace(active); s == "active" || s == "activating" || s == "deactivating" {
		return fmt.Errorf("firewall rollback is running; wait before retrying")
	}
	if _, err := h.read(runtimeDir + "/pending"); err != nil {
		return fmt.Errorf("firewall rollback already ran; rerun harden")
	}
	// Persist only the confirmed policy. Do not enable the distribution nftables
	// service: its default flush-ruleset would erase k3s rules.
	if err := h.write("/etc/platform/firewall.nft", rules, 0600); err != nil {
		return rollbackNow(err)
	}
	unit := `[Unit]
Description=Platform single-node firewall (owns only platform_guard)
Before=k3s.service
After=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'nft list table inet platform_guard >/dev/null 2>&1 && nft delete table inet platform_guard; exec nft -f /etc/platform/firewall.nft'
[Install]
WantedBy=multi-user.target
`
	if err := h.write("/etc/systemd/system/platform-firewall.service", unit, 0644); err != nil {
		return rollbackNow(err)
	}
	if err := h.run("systemctl", "daemon-reload"); err != nil {
		return rollbackNow(err)
	}
	if err := h.run("systemctl", "enable", "platform-firewall.service"); err != nil {
		return rollbackNow(err)
	}
	return os.Remove(h.Path(runtimeDir + "/pending"))
}

// refuseCIDRFragments errors when a config.yaml.d drop-in sets cluster-cidr or
// service-cidr (with or without a trailing +). Other fragments are fine.
func (h Host) refuseCIDRFragments() error {
	fragments, err := filepath.Glob(h.Path("/etc/rancher/k3s/config.yaml.d/*.yaml"))
	if err != nil {
		return err
	}
	for _, path := range fragments {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if fragmentSetsPodCIDR(string(data)) {
			return fmt.Errorf("k3s config fragment %s sets cluster/service CIDRs; use --skip-hardening", filepath.Base(path))
		}
	}
	return nil
}

func fragmentSetsPodCIDR(data string) bool {
	for _, raw := range strings.Split(data, "\n") {
		line := strings.TrimSpace(strings.SplitN(raw, "#", 2)[0])
		if line == "" {
			continue
		}
		key, _, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		switch key {
		case "cluster-cidr", "cluster-cidr+", "service-cidr", "service-cidr+":
			return true
		}
	}
	return false
}
