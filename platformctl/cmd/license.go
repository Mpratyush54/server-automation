package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/license"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

var (
	licenseKeyFile     string
	licenseOfflineFile string
	licenseStatusJSON  bool
)

// Seams for tests.
var (
	licenseInstaller = func() license.Installer {
		return license.DefaultInstaller(provisionStackPaths.LicenseClient())
	}
	licenseRunner            license.Runner
	licenseStatusPath        = license.StatusFile
	licenseNodeCount         = clusterNodeCount
	licensePublish           = publishLicenseStatus
	licenseWriteRegistryAuth = func(a k3s.ImageRegistryAuth) (bool, error) { return k3s.WriteImageRegistryAuth(cfg.GitHubToken, a) }
	licenseRestartK3s        = func() error { return shell.RunBash("systemctl restart k3s") }
	licenseK3sInstalled      = k3s.IsInstalled
	licenseInstallTimer      = installLicenseTimer
	licensePromptKey         = promptLicenseKey
	licenseInteractive       = func() bool { return !cfg.NonInteractive && term.IsTerminal(int(os.Stdin.Fd())) }
	licenseNow               = time.Now
)

var licenseCmd = &cobra.Command{
	Use:   "license",
	Short: "License key and status",
}

func init() {
	usage := "file holding the Cairn license key (or set " + license.EnvKey + ")"
	provisionCmd.Flags().StringVar(&licenseKeyFile, "license-key-file", "", usage)
	updateCmd.Flags().StringVar(&licenseKeyFile, "license-key-file", "", usage)

	activate := &cobra.Command{Use: "activate", Short: "Activate a license key on this server", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runLicenseActivate(cmd.OutOrStdout()) }}
	activate.Flags().StringVar(&licenseKeyFile, "license-key-file", "", usage)
	status := &cobra.Command{Use: "status", Short: "Show the license status", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runLicenseStatus(cmd.OutOrStdout()) }}
	status.Flags().BoolVar(&licenseStatusJSON, "json", false, "machine-readable output")
	refresh := &cobra.Command{Use: "refresh", Short: "Refresh the license status", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runLicenseRefresh(cmd.OutOrStdout()) }}
	request := &cobra.Command{Use: "request-offline", Short: "Print an offline activation request", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runLicenseRequestOffline(cmd.OutOrStdout()) }}
	installOffline := &cobra.Command{Use: "install-offline", Short: "Install a license file downloaded from your account", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error { return runLicenseInstallOffline(cmd.OutOrStdout()) }}
	installOffline.Flags().StringVar(&licenseOfflineFile, "file", "", "license file")
	_ = installOffline.MarkFlagRequired("file")
	licenseCmd.AddCommand(activate, status, refresh, request, installOffline)
	rootCmd.AddCommand(licenseCmd)
}

func licenseFingerprint(nodes int) license.Fingerprint {
	return license.Fingerprint{Version: Version, Profile: cfg.Profile, Nodes: nodes}
}

// clusterNodeCount counts Kubernetes nodes (1 when unknown).
func clusterNodeCount() int {
	out, err := shell.Output("k3s", "kubectl", "get", "nodes", "-o", "json", "--request-timeout=10s")
	if err != nil {
		return 1
	}
	nodes, err := k3s.ParseNodes([]byte(out))
	if err != nil || len(nodes) == 0 {
		return 1
	}
	return len(nodes)
}

func resolveLicenseKey(prompt bool) (license.Key, error) {
	if licenseKeyFile != "" {
		if _, err := os.Stat(licenseKeyFile); err != nil {
			return license.Key{}, fmt.Errorf("--license-key-file: %w", err)
		}
		abs, err := filepath.Abs(licenseKeyFile)
		if err != nil {
			return license.Key{}, err
		}
		return license.Key{File: abs}, nil
	}
	if v := strings.TrimSpace(os.Getenv(license.EnvKey)); v != "" {
		return license.Key{Value: v}, nil
	}
	if prompt && licenseInteractive() {
		return licensePromptKey()
	}
	return license.Key{}, nil
}

func promptLicenseKey() (license.Key, error) {
	color.Cyan("\n  ■ License key")
	fmt.Printf("    Get a free key at %s\n", license.SignupURL)
	fmt.Print("    License key (Enter to skip): ")
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		line, rerr := bufio.NewReader(os.Stdin).ReadString('\n')
		if rerr != nil && line == "" {
			return license.Key{}, nil
		}
		b = []byte(line)
	}
	return license.Key{Value: strings.TrimSpace(string(b))}, nil
}

func licenseClient(ctx context.Context, install bool) (*license.Client, error) {
	in := licenseInstaller()
	if install {
		path, err := in.Ensure(ctx)
		if err != nil {
			return nil, err
		}
		return &license.Client{Path: path, Run: licenseRunner}, nil
	}
	path, ok := in.Locate()
	if !ok {
		return nil, fmt.Errorf("license client not installed")
	}
	return &license.Client{Path: path, Run: licenseRunner}, nil
}

func recordLicense(out io.Writer, r license.Report, publish bool) license.Status {
	s := license.NewStatus(r, cfg.LicenseEnforce, licenseNow())
	if err := license.WriteStatus(licenseStatusPath, s); err != nil {
		fmt.Fprintf(out, "  · license status not saved: %v\n", err)
	}
	if publish {
		if err := licensePublish(s); err != nil {
			fmt.Fprintf(out, "  · license status not published to the cluster: %v\n", err)
		}
	}
	return s
}

func applyLicenseDecision(out io.Writer, r license.Report) error {
	d := license.Decide(r, cfg.LicenseEnforce)
	switch {
	case !d.Proceed:
		return fmt.Errorf("%s", d.Message)
	case d.Warn:
		fmt.Fprintf(out, "  ⚠ %s\n", d.Message)
	default:
		fmt.Fprintf(out, "  ✓ %s\n", d.Message)
	}
	return nil
}

// licenseUnavailable reports a missing client: fatal only when enforcing.
func licenseUnavailable(out io.Writer, err error) error {
	if cfg.LicenseEnforce {
		return fmt.Errorf("license client: %w", err)
	}
	fmt.Fprintf(out, "  · license check skipped: %v\n", err)
	return nil
}

// licenseProvision runs before any component is installed.
func licenseProvision(out io.Writer, offline bool) error {
	ctx := context.Background()
	c, err := licenseClient(ctx, true)
	if err != nil {
		return licenseUnavailable(out, err)
	}
	key, err := resolveLicenseKey(true)
	if err != nil {
		return err
	}
	var r license.Report
	if key.Empty() {
		r, err = c.Verify(ctx, 1)
	} else {
		r, err = c.Activate(ctx, licenseFingerprint(1), key)
	}
	if err != nil {
		return licenseUnavailable(out, err)
	}
	recordLicense(out, r, false)
	if err := applyLicenseDecision(out, r); err != nil {
		return err
	}
	return licenseImageRegistry(ctx, out, c, offline, false)
}

// licenseUpgrade gates update and upgrade.
func licenseUpgrade(out io.Writer) error {
	ctx := context.Background()
	c, err := licenseClient(ctx, true)
	if err != nil {
		return licenseUnavailable(out, err)
	}
	key, err := resolveLicenseKey(false)
	if err != nil {
		return err
	}
	r, err := c.Upgrade(ctx, licenseFingerprint(licenseNodeCount()), key)
	if err != nil {
		return licenseUnavailable(out, err)
	}
	recordLicense(out, r, true)
	if err := applyLicenseDecision(out, r); err != nil {
		return err
	}
	return licenseImageRegistry(ctx, out, c, false, true)
}

// licenseNodeCheck gates adding a node (total nodes after the join).
func licenseNodeCheck(out io.Writer, total int) error {
	if joinedRole() != "" {
		return nil
	}
	ctx := context.Background()
	c, err := licenseClient(ctx, false)
	if err != nil {
		return licenseUnavailable(out, err)
	}
	r, err := c.Verify(ctx, total)
	if err != nil {
		return licenseUnavailable(out, err)
	}
	return applyLicenseDecision(out, r)
}

// licenseImageRegistry switches to the licensed image registry when enforcing.
func licenseImageRegistry(ctx context.Context, out io.Writer, c *license.Client, offline, restart bool) error {
	if !cfg.LicenseEnforce || offline {
		return nil
	}
	if cfg.ImageRegistry != config.DefaultImageRegistry && cfg.ImageRegistry != config.LicensedImageRegistry {
		return nil
	}
	rc, err := c.RegistryCredentials(ctx)
	if err != nil {
		return fmt.Errorf("image registry: %w", err)
	}
	changed, err := licenseWriteRegistryAuth(k3s.ImageRegistryAuth{Registry: rc.Registry, Username: rc.Username, Password: rc.Password})
	if err != nil {
		return fmt.Errorf("image registry: %w", err)
	}
	cfg.ImageRegistry = config.LicensedImageRegistry
	if changed && restart && licenseK3sInstalled() {
		if err := licenseRestartK3s(); err != nil {
			return fmt.Errorf("restart k3s: %w", err)
		}
	}
	fmt.Fprintf(out, "  ✓ Images from %s\n", cfg.ImageRegistry)
	return nil
}

func publishLicenseStatus(s license.Status) error {
	hostKubeconfig()
	cm, err := license.ConfigMap(s)
	if err != nil {
		return err
	}
	b, err := json.Marshal(cm)
	if err != nil {
		return err
	}
	_, err = shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, string(b))
	return err
}

// publishLicenseFile publishes the saved status (after the cluster exists).
func publishLicenseFile(out io.Writer) {
	s, err := license.ReadStatus(licenseStatusPath)
	if err != nil {
		return
	}
	if err := licensePublish(s); err != nil {
		fmt.Fprintf(out, "  · license status not published to the cluster: %v\n", err)
	}
}

const (
	licenseTimerUnit   = "cairn-license-refresh.timer"
	licenseServiceUnit = "cairn-license-refresh.service"
)

func licenseUnits(exe string) (service, timer string) {
	service = "[Unit]\nDescription=Cairn license status\nWants=network-online.target\nAfter=network-online.target\n\n" +
		"[Service]\nType=oneshot\nExecStart=" + exe + " license refresh --auto\nNice=10\n"
	timer = "[Unit]\nDescription=Cairn license status\n\n[Timer]\nOnCalendar=weekly\nRandomizedDelaySec=6h\nPersistent=true\n\n" +
		"[Install]\nWantedBy=timers.target\n"
	return service, timer
}

func installLicenseTimer() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	service, timer := licenseUnits(exe)
	if err := os.WriteFile("/etc/systemd/system/"+licenseServiceUnit, []byte(service), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile("/etc/systemd/system/"+licenseTimerUnit, []byte(timer), 0o644); err != nil {
		return err
	}
	if err := shell.RunSilent("systemctl", "daemon-reload"); err != nil {
		return err
	}
	return shell.RunSilent("systemctl", "enable", "--now", licenseTimerUnit)
}

// finishLicenseSetup runs at the end of provision.
func finishLicenseSetup(out io.Writer) {
	if _, ok := licenseInstaller().Locate(); !ok {
		return
	}
	publishLicenseFile(out)
	if err := licenseInstallTimer(); err != nil {
		fmt.Fprintf(out, "  · %s not installed: %v\n", licenseTimerUnit, err)
	}
}

func currentLicenseStatus() (license.Status, bool) {
	if c, err := licenseClient(context.Background(), false); err == nil {
		if r, err := c.Verify(context.Background(), 0); err == nil {
			return license.NewStatus(r, cfg.LicenseEnforce, licenseNow()), true
		}
	}
	s, err := license.ReadStatus(licenseStatusPath)
	return s, err == nil
}

func printLicenseStatus(out io.Writer) {
	s, ok := currentLicenseStatus()
	if !ok {
		fmt.Fprintln(out, "  License: no license status yet (sudo platformctl license activate)")
		return
	}
	fmt.Fprintf(out, "  License: %s\n", s.Summary())
}

func runLicenseStatus(out io.Writer) error {
	if licenseStatusJSON {
		s, ok := currentLicenseStatus()
		if !ok {
			return fmt.Errorf("no license status")
		}
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(s.Public())
	}
	printLicenseStatus(out)
	return nil
}

func runLicenseActivate(out io.Writer) error {
	ctx := context.Background()
	c, err := licenseClient(ctx, true)
	if err != nil {
		return err
	}
	key, err := resolveLicenseKey(true)
	if err != nil {
		return err
	}
	if key.Empty() {
		return fmt.Errorf("no license key: pass --license-key-file or set %s (get one at %s)", license.EnvKey, license.SignupURL)
	}
	r, err := c.Activate(ctx, licenseFingerprint(licenseNodeCount()), key)
	if err != nil {
		return err
	}
	s := recordLicense(out, r, true)
	fmt.Fprintf(out, "  License: %s\n", s.Summary())
	if !r.AllowProvision {
		return fmt.Errorf("%s", license.Decide(r, true).Message)
	}
	return nil
}

// runLicenseRefresh never fails on the license result.
func runLicenseRefresh(out io.Writer) error {
	ctx := context.Background()
	c, err := licenseClient(ctx, false)
	if err != nil {
		fmt.Fprintf(out, "license: %v\n", err)
		return nil
	}
	r, err := c.Checkin(ctx, licenseFingerprint(licenseNodeCount()))
	if err != nil {
		fmt.Fprintf(out, "license: %v\n", err)
		return nil
	}
	s := recordLicense(out, r, true)
	fmt.Fprintf(out, "license: %s\n", s.Summary())
	return nil
}

func runLicenseRequestOffline(out io.Writer) error {
	ctx := context.Background()
	c, err := licenseClient(ctx, true)
	if err != nil {
		return err
	}
	req, err := c.RequestOffline(ctx, licenseFingerprint(licenseNodeCount()))
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Paste this at %s:\n", license.AccountURL)
	fmt.Fprintln(out, req)
	return nil
}

func runLicenseInstallOffline(out io.Writer) error {
	ctx := context.Background()
	c, err := licenseClient(ctx, true)
	if err != nil {
		return err
	}
	r, err := c.InstallOffline(ctx, licenseOfflineFile)
	if err != nil {
		return err
	}
	s := recordLicense(out, r, true)
	fmt.Fprintf(out, "  License: %s\n", s.Summary())
	if !r.AllowProvision {
		return fmt.Errorf("%s", license.Decide(r, true).Message)
	}
	return nil
}

// Seams for tests.
var (
	licenseReadRegistryAuth  = k3s.ReadImageRegistryAuth
	licenseStoreRegistryAuth = k3s.StoreImageRegistryAuth
)

// writeRegistryAuth copies this server's image registry credentials for a joining node.
func writeRegistryAuth(stderr io.Writer, output string) error {
	if output == "" {
		return nil
	}
	a, ok := licenseReadRegistryAuth()
	if !ok {
		return fmt.Errorf("--registry-auth-output: this server has no image registry credentials")
	}
	b, _ := json.Marshal(a)
	if err := os.WriteFile(output, b, 0o600); err != nil {
		return fmt.Errorf("--registry-auth-output: %w", err)
	}
	fmt.Fprintf(stderr, "Image registry credentials written to %s (mode 0600). Pass it to join with --registry-auth and delete it afterwards.\n", output)
	return nil
}

// readRegistryAuth stores credentials from writeRegistryAuth on this node.
func readRegistryAuth(path string) error {
	if path == "" {
		return nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var a k3s.ImageRegistryAuth
	if err := json.Unmarshal(b, &a); err != nil {
		return fmt.Errorf("invalid credentials file")
	}
	return licenseStoreRegistryAuth(a)
}
