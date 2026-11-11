package cmd

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/harden"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/spf13/cobra"
)

var hardenCmd = &cobra.Command{
	Use:   "harden",
	Short: "Apply or reconcile the single-node Ubuntu host security baseline",
	RunE: func(cmd *cobra.Command, args []string) error {
		unlock, err := state.AcquireLock("harden")
		if err != nil {
			return err
		}
		defer unlock()
		if cfg.SkipHardening {
			fmt.Println("Host hardening skipped (PLATFORM_HARDEN=false or SKIP_HARDENING=true)")
			return nil
		}
		return runHardening()
	},
}

func init() {
	rootCmd.AddCommand(hardenCmd)
	provisionCmd.Flags().BoolVar(&cfg.SkipHardening, "skip-hardening", cfg.SkipHardening, "leave host security to the operator (PLATFORM_HARDEN=false)")
	rootCmd.PersistentFlags().BoolVar(&cfg.WAF, "waf", cfg.WAF, "enable ingress ModSecurity + OWASP CRS in detection mode (PLATFORM_WAF)")
	rootCmd.PersistentFlags().BoolVar(&cfg.NginxAuthJail, "nginx-auth-jail", cfg.NginxAuthJail, "ban ingress basic-auth failures from /var/log/platform/ingress-error.log (requires log export)")
}

func hardeningHost() harden.Host {
	keys := []string{"/root/.ssh/authorized_keys"}
	if name := os.Getenv("SUDO_USER"); name != "" && name != "root" {
		if u, err := user.Lookup(name); err == nil {
			keys = append(keys, filepath.Join(u.HomeDir, ".ssh", "authorized_keys"))
		}
	}
	return harden.Host{Run: shell.Output, KeyFiles: keys, NginxAuth: cfg.NginxAuthJail, Warn: func(s string) { fmt.Println("WARNING: " + s) }}
}

// existingInstall reports a host provisioned before (tests replace it).
var existingInstall = func() bool { return state.IsDone("platform") || state.IsDone("k3s") }

// confirmHardening makes host hardening on an existing server explicit: it
// changes SSH, packet filtering, automatic updates and fail2ban on a host that
// is already serving. Interactive runs ask (default yes keeps the secure
// baseline); non-interactive runs print a notice naming the opt-out.
func confirmHardening(in io.Reader, out io.Writer, interactive bool) {
	if cfg.SkipHardening || !existingInstall() {
		return
	}
	fmt.Fprintln(out, "NOTICE: this server is already provisioned. Provision (re)applies the host security baseline:")
	fmt.Fprintln(out, "  SSH settings, nftables host firewall (only 22/80/443 open), fail2ban, unattended upgrades, chrony.")
	fmt.Fprintln(out, "  To leave host security unchanged: SKIP_HARDENING=true, PLATFORM_HARDEN=false or --skip-hardening.")
	if !interactive {
		return
	}
	fmt.Fprint(out, "Apply the host security baseline now? [Y/n] ")
	line, _ := bufio.NewReader(in).ReadString('\n')
	if a := strings.TrimSpace(strings.ToLower(line)); a == "n" || a == "no" {
		cfg.SkipHardening = true
		fmt.Fprintln(out, "Host hardening skipped for this run (saved as PLATFORM_HARDEN=false).")
	}
}

func hardeningPreflight() {
	if !cfg.SkipHardening && !hardeningHost().HasLoginKey() {
		fmt.Println("WARNING: No unrestricted root/SUDO_USER authorized key; hardening will retain SSH password authentication. Add a login key before provisioning to disable it safely.")
	}
}

// runHardening applies the whole baseline (`platformctl harden`).
func runHardening() error {
	if err := hardenPrepare(); err != nil {
		return err
	}
	return hardenFirewall()
}

// hardenPrepare installs and configures packages, updates, fail2ban, chrony
// and SSH. It does not touch packet filtering, so provision runs it in the
// background while the cluster installs (it took ~1 minute in series).
func hardenPrepare() error {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return fmt.Errorf("host hardening requires Linux and root (sudo platformctl harden)")
	}
	// This baseline deliberately closes node API/overlay ports to external
	// clients. Do not apply it to an existing multi-node cluster.
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
	nodes, err := shell.Output("kubectl", "get", "nodes", "-o", "name", "--request-timeout=10s")
	if err != nil {
		return fmt.Errorf("verify single-node cluster before hardening: %w", err)
	}
	if len(strings.Fields(nodes)) != 1 {
		return fmt.Errorf("host hardening supports one node; multi-node clusters require an operator-managed firewall (--skip-hardening)")
	}
	if err := state.Clear("harden"); err != nil {
		return err
	}
	if err := state.MarkInProgress("harden"); err != nil {
		return err
	}
	return hardeningHost().Prepare()
}

// hardenFirewall applies the firewall with its automatic rollback. It needs
// the platform running: confirmation checks live local ports and the API.
func hardenFirewall() error {
	h := hardeningHost()
	if err := h.ApplyFirewall(func() bool { return confirmFirewall(cfg.NonInteractive, localHardeningHealth) }); err != nil {
		return err
	}
	if h.HasLoginKey() {
		_ = state.MarkDone("harden-ssh")
	} else {
		_ = state.Clear("harden-ssh")
	}
	return state.MarkDone("harden")
}

// startHardenPrepare runs hardenPrepare in the background (provision).
func startHardenPrepare() <-chan error {
	done := make(chan error, 1)
	if cfg.SkipHardening {
		done <- nil
		return done
	}
	go func() {
		track := state.Track("harden: packages, SSH, fail2ban, chrony (background)")
		err := hardenPrepare()
		if err != nil {
			track("failed")
		} else {
			track("ok")
		}
		done <- err
	}()
	return done
}

// Probes are bounded well below the 120s rollback window. Auto never confirms
// a bare host: provision calls this after ingress and the API are available.
func localHardeningHealth() bool {
	for _, port := range []string{"22", "80", "443", "6443"} {
		c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", port), 3*time.Second)
		if err != nil {
			fmt.Printf("Firewall confirmation: local port %s unavailable\n", port)
			return false
		}
		_ = c.Close()
	}
	out, err := shell.Output("ss", "-tlnp", "sport = :22")
	if err != nil || !strings.Contains(out, "sshd") {
		return false
	}
	// Local readiness checks the platform API through real ingress routing.
	// -k permits the documented internal CA/fake-certificate bootstrap path;
	// --resolve keeps the connection on loopback, independent of public DNS.
	if cfg.Domain == "" {
		return false
	}
	_, err = shell.Output("curl", "--noproxy", "*", "-kfsS", "--max-time", "10", "--resolve", cfg.Domain+":443:127.0.0.1", "https://"+cfg.Domain+"/api/health/ready")
	return err == nil
}

func confirmFirewall(auto bool, healthy func() bool) bool {
	return confirmFirewallInput(auto, healthy, os.Stdin, 90*time.Second)
}

func confirmFirewallInput(auto bool, healthy func() bool, input io.Reader, timeout time.Duration) bool {
	if !healthy() {
		return false
	}
	if auto {
		return true
	}
	fmt.Println("Firewall rollback is armed. Verify a NEW SSH login and portal access from another terminal; type 'confirm' within 90 seconds to keep these rules:")
	answer := make(chan string, 1)
	go func() {
		s := bufio.NewScanner(input)
		if s.Scan() {
			answer <- strings.TrimSpace(s.Text())
		} else {
			answer <- ""
		}
	}()
	select {
	case s := <-answer:
		return s == "confirm"
	case <-time.After(timeout):
		return false
	}
}

func printHardeningStatus() {
	status := "not applied (or last attempt incomplete)"
	if state.IsDone("harden") {
		status = "applied; SSH password auth retained (no login key)"
		if state.IsDone("harden-ssh") {
			status = "applied; SSH key-only"
		}
	}
	fmt.Println("  Host hardening: " + status)
	if _, err := os.Stat("/var/lib/platform/harden/pending"); err == nil {
		fmt.Println("  Firewall confirmation/rollback pending")
	}
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		fmt.Println("  Security updates: reboot required (automatic reboot disabled)")
	}
}
