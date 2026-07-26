package cmd

import (
	"fmt"
	"os"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/docker"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/helm"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/preflight"
)

var (
	cfgFile string
	cfg     = config.Load()
	Version = "dev"
)

var rootCmd = &cobra.Command{
	Use:   "platformctl",
	Short: "Platform server bootstrap and management tool",
	Long:  `PlatformCTL provisions and manages a full Platform stack on a fresh Ubuntu server.`,
	Run: func(cmd *cobra.Command, args []string) {
		cmd.Help()
	},
}

var provisionCmd = &cobra.Command{
	Use:   "provision",
	Short: "Full server bootstrap (replaces bootstrap.sh)",
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
	},
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(provisionCmd)
	rootCmd.AddCommand(installCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(seedCmd)
	rootCmd.AddCommand(versionCmd)

	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default /etc/platform/.env)")
	rootCmd.PersistentFlags().BoolVar(&cfg.NonInteractive, "auto", false, "non-interactive mode")
}

func runProvision() error {
	color.Cyan("\n  ========================================")
	color.Cyan("   Platform Server Bootstrap v%s", Version)
	color.Cyan("  ========================================\n")

	if !cfg.NonInteractive {
		if err := cfg.PromptInteractive(); err != nil {
			return err
		}
	}

	cfg.GenerateSecrets()

	if !cfg.SkipPreflight {
		color.Cyan("\n  ■ Pre-flight Checks\n")
		result := preflight.Check()
		preflight.PrintResult(result)
		if !result.Passed {
			return fmt.Errorf("pre-flight checks failed")
		}
	}

	if err := docker.Install(); err != nil {
		return fmt.Errorf("docker install failed: %w", err)
	}

	if err := docker.WaitReady(); err != nil {
		return err
	}

	if !cfg.SkipK8s {
		if err := k3s.Install(); err != nil {
			return fmt.Errorf("k3s install failed: %w", err)
		}
	}

	if err := helm.Install(); err != nil {
		return fmt.Errorf("helm install failed: %w", err)
	}

	if err := components.Namespace(); err != nil {
		color.Yellow("  ⚠ namespace creation: %v", err)
	}

	installList := []struct {
		name string
		fn   func(*config.Config) error
	}{
		{"ingress-nginx", components.InstallIngressNginx},
		{"cert-manager", components.InstallCertManager},
		{"postgresql", components.InstallPostgreSQL},
		{"mongodb", components.InstallMongoDB},
		{"redis", components.InstallRedis},
		{"minio", components.InstallMinIO},
	}

	for _, item := range installList {
		if err := item.fn(cfg); err != nil {
			color.Red("  ✗ %s failed: %v", item.name, err)
		}
	}

	if cfg.InstallArgoCD {
		components.InstallArgoCD(cfg)
	}

	if cfg.InstallMonitoring {
		components.InstallMonitoring(cfg)
	}

	components.InstallOAuthProxy(cfg)

	if cfg.InstallPortainer {
		components.InstallPortainer(cfg)
	}

	if cfg.InstallInfisical {
		components.InstallInfisical(cfg)
	}

	components.InstallPlatform(cfg)

	components.ProvisionComplete(cfg)

	cfg.SaveEnvFile("/etc/platform/.env")

	return nil
}

func runInstall(name string) error {
	comp := components.Find(name)
	if comp == nil {
		return fmt.Errorf("unknown component: %s\nAvailable: ingress-nginx, cert-manager, postgresql, mongodb, redis, minio, argocd, monitoring, oauth2-proxy, portainer, infisical, platform", name)
	}
	return comp.Install(cfg)
}
