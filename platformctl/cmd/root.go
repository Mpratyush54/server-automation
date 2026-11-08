package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

var (
	cfgFile string
	cfg     = config.Load()
	Version = "dev"
)

var rootCmd = &cobra.Command{
	Use:          "platformctl",
	SilenceUsage: true, // a failing step should not dump the help text into its log
	Short: "Platform server bootstrap and management tool",
	Long:  `PlatformCTL provisions and manages a full Platform stack on a fresh Ubuntu server using pre-built GHCR images (no on-server compile).`,
	Run: func(cmd *cobra.Command, args []string) {
		cmd.Help()
	},
}

var provisionCmd = &cobra.Command{
	Use:   "provision",
	Short: "Full server bootstrap from pre-built images",
	RunE: func(cmd *cobra.Command, args []string) error {
		return runProvision()
	},
}

var installCmd = &cobra.Command{
	Use:   "install <component>",
	Short: "Install a specific component",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runInstall(args[0])
	},
	ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
		var names []string
		for _, c := range components.All() {
			names = append(names, c.Name)
		}
		return names, cobra.ShellCompDirectiveNoFileComp
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check health of all platform components",
	RunE: func(cmd *cobra.Command, args []string) error {
		color.Cyan("\n  ■ Platform Health Check\n")
		if meta, err := state.LockInfo(); err == nil && meta != "" {
			color.Yellow("  · provision lock present (%s) — status does not wait on it", meta)
		}
		if err := components.CheckHealth(); err != nil {
			return fmt.Errorf("health check failed: %w", err)
		}
		return nil
	},
}

var seedCmd = &cobra.Command{
	Use:   "seed",
	Short: "Seed admin user and default configuration",
	RunE: func(cmd *cobra.Command, args []string) error {
		return components.SeedAdmin(cfg)
	},
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print platformctl version",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("platformctl %s\n", Version)
		fmt.Printf("default image tag: %s\n", config.DefaultImageTag)
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

var updateCmd = &cobra.Command{
	Use:   "update",
	Short: "Pull newest Platform images from GHCR and roll deployments",
	RunE: func(cmd *cobra.Command, args []string) error {
		os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
		return components.UpdateImages(cfg)
	},
}

var recoverCmd = &cobra.Command{
	Use:   "recover",
	Short: "Restore API and admin login after a broken secret rotate",
	Long: `Backs up /etc/platform and cluster secrets, writes passwords to
/etc/platform/.env and /etc/platform/credentials, then reconnects Postgres.

ALTER USER is used only when no stored password still authenticates.
The working password is saved on disk before any role change.

After recover:

  sudo platformctl update`,
	RunE: func(cmd *cobra.Command, args []string) error {
		os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
		return components.RecoverAccess(cfg)
	},
}

var backupCmd = &cobra.Command{
	Use:   "backup",
	Short: "Copy /etc/platform/.env and database secrets to a timestamped host backup",
	RunE: func(cmd *cobra.Command, args []string) error {
		os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
		dir, err := components.BackupLocalState("", "")
		if err != nil {
			return err
		}
		fmt.Printf("backup written to %s\n", dir)
		return nil
	},
}

var chartsJSON bool

// chartsCmd prints the pinned version table (internal/versions) for CI scripts
// such as the image-list generator and the offline bundle builder.
var chartsCmd = &cobra.Command{
	Use:    "charts",
	Short:  "Print pinned k3s, Helm and chart versions",
	Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if chartsJSON {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			return enc.Encode(map[string]any{
				"k3s":    versions.K3sVersion,
				"helm":   versions.HelmVersion,
				"charts": versions.All(),
			})
		}
		fmt.Printf("k3s  %s\nhelm %s\n", versions.K3sVersion, versions.HelmVersion)
		for _, c := range versions.All() {
			fmt.Printf("%-24s %-12s %s\n", c.Name, c.Version, c.RemoteRef())
		}
		return nil
	},
}

func init() {
	chartsCmd.Flags().BoolVar(&chartsJSON, "json", false, "machine-readable output")
	rootCmd.AddCommand(chartsCmd)
	rootCmd.AddCommand(provisionCmd)
	rootCmd.AddCommand(installCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(seedCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(recoverCmd)
	rootCmd.AddCommand(backupCmd)
	rootCmd.AddCommand(versionCmd)

	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default /etc/platform/.env)")
	rootCmd.PersistentFlags().BoolVar(&cfg.NonInteractive, "auto", false, "non-interactive mode")
	provisionCmd.Flags().IntVar(&parallelFlag, "parallel", 0,
		"cluster steps to run at once (default 4, env PLATFORMCTL_PARALLEL; 1 = serial with live output)")
	provisionCmd.Flags().StringVar(&profileFlag, "profile", "",
		"component set: minimal | standard | full (default full, env PLATFORM_PROFILE)")
	provisionCmd.Flags().StringVar(&bundleFlag, "bundle", "",
		"offline bundle: path to platform-bundle-*.tar.zst, or 'auto' to download the matching release")
}

func runInstall(name string) error {
	// Steps launched by `provision` run as children while the parent holds the
	// provision lock; standalone `install` takes the lock itself.
	if !isChild() {
		unlock, err := state.AcquireLock("install:" + name)
		if err != nil {
			return err
		}
		defer unlock()
	}

	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
	comp := components.Find(name)
	if comp == nil {
		return fmt.Errorf("unknown component: %s\nAvailable: ingress-nginx, cert-manager, postgresql, mongodb, redis, minio, argocd, monitoring, oauth2-proxy, portainer, platform, routing, auto-update", name)
	}
	return comp.Install(cfg)
}
