package cmd

import (
	"fmt"
	"os"

	"github.com/fatih/color"
	"github.com/spf13/cobra"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/apt"
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

func init() {
	rootCmd.AddCommand(provisionCmd)
	rootCmd.AddCommand(installCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(seedCmd)
	rootCmd.AddCommand(updateCmd)
	rootCmd.AddCommand(versionCmd)

	rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default /etc/platform/.env)")
	rootCmd.PersistentFlags().BoolVar(&cfg.NonInteractive, "auto", false, "non-interactive mode")
}

func runProvision() error {
	color.Cyan("\n  ========================================")
	color.Cyan("   Platform Server Bootstrap v%s", Version)
	color.Cyan("  ========================================\n")
	color.Cyan("  Images: %s/*:%s\n", cfg.ImageRegistry, cfg.ImageTag)

	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")

	if !cfg.NonInteractive {
		if err := cfg.PromptInteractive(); err != nil {
			return err
		}
	}

	cfg.GenerateSecrets()

	if err := cfg.SaveEnvFile("/etc/platform/.env"); err != nil {
		color.Yellow("  ⚠ could not write /etc/platform/.env yet: %v", err)
	}

	if !cfg.SkipPreflight {
		color.Cyan("\n  ■ Pre-flight Checks\n")
		result := preflight.Check()
		preflight.PrintResult(result)
		if !result.Passed {
			return fmt.Errorf("pre-flight checks failed")
		}
	}

	must := func(step string, err error) error {
		if err != nil {
			color.Red("  ✗ %s failed: %v", step, err)
			return fmt.Errorf("%s failed: %w", step, err)
		}
		return nil
	}

	if err := must("prereqs", apt.InstallPrereqs()); err != nil {
		return err
	}
	if err := must("docker", docker.Install()); err != nil {
		return err
	}
	if err := must("docker-ready", docker.WaitReady()); err != nil {
		return err
	}

	if !cfg.SkipK8s {
		if err := must("k3s", k3s.Install(cfg.Domain)); err != nil {
			return err
		}
	}

	if err := must("helm", helm.Install()); err != nil {
		return err
	}
	if err := must("namespaces", components.Namespace()); err != nil {
		return err
	}

	steps := []struct {
		name string
		fn   func(*config.Config) error
		skip bool
	}{
		{"ingress-nginx", components.InstallIngressNginx, false},
		{"cert-manager", components.InstallCertManager, !cfg.InstallCertManager},
		{"postgresql", components.InstallPostgreSQL, false},
		{"mongodb", components.InstallMongoDB, false},
		{"redis", components.InstallRedis, false},
		{"minio", components.InstallMinIO, false},
		{"argocd", components.InstallArgoCD, !cfg.InstallArgoCD},
		{"monitoring", components.InstallMonitoring, !cfg.InstallMonitoring},
		{"oauth2-proxy", components.InstallOAuthProxy, false},
		{"portainer", components.InstallPortainer, !cfg.InstallPortainer},
		{"infisical", components.InstallInfisical, !cfg.InstallInfisical},
		{"platform", components.InstallPlatform, false},
		{"auto-update", components.InstallAutoUpdate, !cfg.AutoUpdate},
	}

	for _, item := range steps {
		if item.skip {
			color.Yellow("  ○ skipping %s", item.name)
			continue
		}
		if err := must(item.name, item.fn(cfg)); err != nil {
			color.Red("\n  Provision stopped. Fix the error and re-run:")
			color.Red("    sudo platformctl provision --auto")
			color.Red("  Completed steps are skipped via /etc/platform/.bootstrap_state")
			return err
		}
	}

	if err := components.SeedAdmin(cfg); err != nil {
		color.Yellow("  ⚠ seed: %v", err)
	}

	_ = cfg.SaveEnvFile("/etc/platform/.env")
	components.ProvisionComplete(cfg)
	return nil
}

func runInstall(name string) error {
	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")
	comp := components.Find(name)
	if comp == nil {
		return fmt.Errorf("unknown component: %s\nAvailable: ingress-nginx, cert-manager, postgresql, mongodb, redis, minio, argocd, monitoring, oauth2-proxy, portainer, infisical, platform", name)
	}
	return comp.Install(cfg)
}
