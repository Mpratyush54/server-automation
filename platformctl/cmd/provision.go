package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/fatih/color"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/apt"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/bundle"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/helm"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/preflight"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/runner"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// childEnv marks a platformctl process started by provision to run one step.
// Children skip the provision lock (the parent holds it).
const childEnv = "PLATFORMCTL_CHILD"

// defaultParallel is how many cluster steps run at once. 4 keeps a minimum-spec
// box (4 cores / 8 GB) responsive while overlapping image pulls and pod starts.
const defaultParallel = 4

var (
	parallelFlag int
	profileFlag  string
	bundleFlag   string
)

// installBundle installs an offline bundle from a local path, or downloads the
// one matching this release when path is "auto".
func installBundle(path string) error {
	if path == "auto" {
		dir := "/var/lib/platform/bundles"
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		color.Cyan("  ■ Downloading offline bundle %s (%s)...", config.DefaultImageTag, runtime.GOARCH)
		p, err := bundle.Fetch(context.Background(), config.DefaultImageTag, runtime.GOARCH, dir)
		if err != nil {
			return fmt.Errorf("fetch bundle: %w", err)
		}
		path = p
	}
	color.Cyan("  ■ Installing offline bundle %s...", path)
	if err := bundle.Install(path); err != nil {
		return err
	}
	color.Green("  ✓ Offline bundle installed (images → k3s, charts → %s)", versions.ChartCacheDir)
	return nil
}

func isChild() bool { return os.Getenv(childEnv) == "1" }

func resolveParallel() int {
	if parallelFlag > 0 {
		return parallelFlag
	}
	if v, err := strconv.Atoi(os.Getenv("PLATFORMCTL_PARALLEL")); err == nil && v > 0 {
		return v
	}
	return defaultParallel
}

// stepDef is one cluster step in the provision graph.
type stepDef struct {
	name string
	deps []string
	skip bool
	// args run the step as a child: `platformctl <args...>`.
	args []string
	// fn runs the step in-process (used when parallel == 1).
	fn func(*config.Config) error
	// warnOnly: failure is reported but does not fail provision.
	warnOnly bool
}

// provisionGraph is the dependency graph of cluster steps. Order matters: when
// several steps are ready, earlier ones start first, so long steps (monitoring)
// and critical-path steps (databases → platform) come first.
//
// Nothing here creates Ingress objects except routing, so only routing must
// wait for ingress-nginx (its admission webhook rejects Ingress creates until
// the controller is ready).
func provisionGraph(c *config.Config) []stepDef {
	install := func(name string) []string { return []string{"install", name} }
	return []stepDef{
		{name: "monitoring", skip: !c.InstallMonitoring, args: install("monitoring"), fn: components.InstallMonitoring},
		{name: "postgresql", args: install("postgresql"), fn: components.InstallPostgreSQL},
		{name: "mongodb", args: install("mongodb"), fn: components.InstallMongoDB},
		{name: "redis", args: install("redis"), fn: components.InstallRedis},
		{name: "minio", args: install("minio"), fn: components.InstallMinIO},
		{name: "ingress-nginx", args: install("ingress-nginx"), fn: components.InstallIngressNginx},
		{name: "cert-manager", skip: !c.InstallCertManager, args: install("cert-manager"), fn: components.InstallCertManager},
		{name: "argocd", skip: !c.InstallArgoCD, args: install("argocd"), fn: components.InstallArgoCD},
		{name: "oauth2-proxy", args: install("oauth2-proxy"), fn: components.InstallOAuthProxy},
		{name: "portainer", skip: !c.InstallPortainer, args: install("portainer"), fn: components.InstallPortainer},
		{name: "platform", deps: []string{"postgresql", "mongodb", "redis", "minio"},
			args: install("platform"), fn: components.InstallPlatform},
		{name: "infisical", deps: []string{"postgresql", "redis"}, skip: !c.InstallInfisical,
			args: install("infisical"), fn: components.InstallInfisical},
		{name: "routing", deps: []string{
			"ingress-nginx", "cert-manager", "platform", "argocd", "monitoring",
			"oauth2-proxy", "portainer", "infisical", "minio",
		}, args: install("routing"), fn: components.InstallRouting},
		{name: "auto-update", deps: []string{"argocd", "platform"}, skip: !c.AutoUpdate,
			args: install("auto-update"), fn: components.InstallAutoUpdate},
		{name: "seed", deps: []string{"platform"}, args: []string{"seed"}, fn: components.SeedAdmin, warnOnly: true},
	}
}

func runProvision() error {
	unlock, err := state.AcquireLock("provision")
	if err != nil {
		return err
	}
	defer unlock()
	started := time.Now()
	state.ResetTimings()

	color.Cyan("\n  ========================================")
	color.Cyan("   Platform Server Bootstrap v%s", Version)
	color.Cyan("  ========================================\n")
	color.Cyan("  Images: %s/*:%s\n", cfg.ImageRegistry, cfg.ImageTag)
	color.Cyan("  Resume: %s (%s)\n", state.StatusLine(), state.DefaultPath)

	os.Setenv("KUBECONFIG", "/etc/rancher/k3s/k3s.yaml")

	if profileFlag != "" {
		if err := cfg.ApplyProfile(profileFlag); err != nil {
			return err
		}
		color.Cyan("  Profile: %s\n", profileFlag)
	}

	if !cfg.NonInteractive {
		if err := cfg.PromptInteractive(); err != nil {
			return err
		}
	} else {
		color.Yellow("  · non-interactive (--auto): using /etc/platform/.env and environment\n")
	}

	cfg.GenerateSecrets()
	if cfg.PasswordGenerated {
		color.Green("  ✓ Admin password auto-generated (saved to /etc/platform/.env)")
		fmt.Printf("    ADMIN_PASSWORD=%s\n", cfg.AdminPassword)
	}

	// Child steps load their config from this file — it must be written before
	// any cluster step starts.
	if err := cfg.SaveEnvFile("/etc/platform/.env"); err != nil {
		color.Yellow("  ⚠ could not write /etc/platform/.env yet: %v", err)
	} else {
		color.Cyan("  · config saved → /etc/platform/.env (domain=%s email=%s)\n", cfg.Domain, cfg.AdminEmail)
	}

	if !cfg.SkipPreflight {
		color.Cyan("\n  ■ Pre-flight Checks\n")
		result := preflight.Check()
		preflight.PrintResult(result)
		if !result.Passed {
			return fmt.Errorf("pre-flight checks failed")
		}
	}

	fail := func(step string, err error) error {
		color.Red("  ✗ %s failed: %v", step, err)
		printResumeHint()
		return fmt.Errorf("%s failed: %w", step, err)
	}
	hostStep := func(name string, fn func() error) error {
		_ = state.MarkInProgress(name)
		done := state.Track(name)
		if err := fn(); err != nil {
			done("failed")
			return fail(name, err)
		}
		done("ok")
		return nil
	}

	// ── Wave 0: host. Docker is no longer installed: k3s ships containerd.
	if err := hostStep("prereqs", apt.InstallPrereqs); err != nil {
		return err
	}
	// Offline bundle must land before k3s starts: k3s imports airgap image
	// tarballs from its images dir at start-up, and cached charts make the
	// prefetch below a no-op.
	if bundleFlag != "" {
		if err := hostStep("bundle", func() error { return installBundle(bundleFlag) }); err != nil {
			return err
		}
	}
	if err := hostStep("helm", helm.Install); err != nil {
		return err
	}

	// Chart tarballs download while k3s installs; helm then installs from disk.
	prefetchDone := make(chan map[string]error, 1)
	go func() {
		done := state.Track("chart-prefetch (background)")
		errs := helm.PrefetchCharts(resolveParallel())
		if len(errs) > 0 {
			done(fmt.Sprintf("%d failed, using remote", len(errs)))
		} else {
			done("ok")
		}
		prefetchDone <- errs
	}()

	if !cfg.SkipK8s {
		if err := hostStep("k3s", func() error { return k3s.Install(cfg.Domain, cfg.GitHubToken) }); err != nil {
			return err
		}
	}

	// ── Wave 1: cluster basics.
	if err := hostStep("namespaces", components.Namespace); err != nil {
		return err
	}
	startBackgroundPrePull()

	if errs := <-prefetchDone; len(errs) > 0 {
		for name, e := range errs {
			color.Yellow("  ⚠ chart prefetch %s: %v (will download during install)", name, e)
		}
	}

	// ── Waves 2–4: cluster steps as a dependency graph.
	parallel := resolveParallel()
	color.Cyan("\n  ■ Installing cluster components (parallel=%d, logs: %s)\n", parallel, state.DefaultLogDir)
	if err := runGraph(provisionGraph(cfg), parallel); err != nil {
		printResumeHint()
		printTimings(started)
		return err
	}

	_ = cfg.SaveEnvFile("/etc/platform/.env")
	printTimings(started)
	components.ProvisionComplete(cfg)
	return nil
}

func printResumeHint() {
	color.Red("\n  Provision stopped. Fix the error and re-run:")
	color.Red("    sudo platformctl provision --auto")
	color.Red("  Progress saved in %s — completed steps are skipped", state.DefaultPath)
	color.Red("  Only one provision can run at a time (lock: %s)", state.DefaultLockPath)
}

func printTimings(started time.Time) {
	total := time.Since(started)
	color.Cyan("\n  ■ Step timings\n")
	state.WriteTimingTable(os.Stdout, total)
	if p, err := state.SaveTimingTable(state.DefaultLogDir, total); err == nil {
		fmt.Printf("  (saved to %s)\n", p)
	}
}

// runGraph executes cluster steps. parallel == 1 runs them in-process in graph
// order with live output (the classic serial install). parallel > 1 runs each
// step as a child platformctl process logging to its own file.
func runGraph(steps []stepDef, parallel int) error {
	_ = os.MkdirAll(state.DefaultLogDir, 0755)
	exe, exeErr := os.Executable()
	if parallel > 1 && exeErr != nil {
		color.Yellow("  ⚠ cannot locate platformctl binary (%v) — running serially", exeErr)
		parallel = 1
	}

	byName := map[string]stepDef{}
	nodes := make([]runner.Node, 0, len(steps))
	for _, s := range steps {
		s := s
		byName[s.name] = s
		nodes = append(nodes, runner.Node{
			Name: s.name,
			Deps: s.deps,
			Skip: s.skip,
			Run: func(ctx context.Context) error {
				_ = state.MarkInProgress(s.name)
				var err error
				if parallel == 1 {
					err = s.fn(cfg)
				} else {
					err = runChild(ctx, exe, s)
				}
				if err != nil && s.warnOnly {
					color.Yellow("  ⚠ %s: %v (non-fatal)", s.name, err)
					return nil
				}
				return err
			},
		})
	}

	var outMu sync.Mutex
	say := func(f func()) { outMu.Lock(); defer outMu.Unlock(); f() }

	_, err := runner.Run(context.Background(), nodes, runner.Options{
		Concurrency: parallel,
		OnStart: func(name string) {
			if parallel > 1 {
				say(func() { color.Cyan("  ▶ %-14s started  (log: %s)", name, logPath(name)) })
			}
		},
		OnFinish: func(r runner.Result) {
			state.RecordTiming(state.StepTiming{
				Step: r.Name, Start: time.Now().Add(-r.Duration), Duration: r.Duration, Status: string(r.Status),
			})
			say(func() {
				switch r.Status {
				case runner.StatusOK:
					color.Green("  ✓ %-14s %s", r.Name, r.Duration.Round(time.Second))
				case runner.StatusSkipped:
					color.Yellow("  ○ %-14s skipped", r.Name)
				case runner.StatusBlocked:
					color.Yellow("  · %-14s not started (stopped after an earlier failure)", r.Name)
				case runner.StatusFailed:
					color.Red("  ✗ %-14s failed after %s: %v", r.Name, r.Duration.Round(time.Second), r.Err)
					if parallel > 1 {
						printLogTail(logPath(r.Name), 30)
					}
				}
			})
		},
	})
	return err
}

func logPath(step string) string { return filepath.Join(state.DefaultLogDir, step+".log") }

func runChild(ctx context.Context, exe string, s stepDef) error {
	f, err := os.OpenFile(logPath(s.name), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	fmt.Fprintf(f, "# platformctl %s — %s\n", strings.Join(s.args, " "), time.Now().UTC().Format(time.RFC3339))

	c := exec.CommandContext(ctx, exe, s.args...)
	c.Stdout, c.Stderr = f, f
	c.Env = append(childEnviron(os.Environ(), envFileKeys(envFilePath)),
		childEnv+"=1", "PLATFORMCTL_AUTO=true", "KUBECONFIG=/etc/rancher/k3s/k3s.yaml")
	if err := c.Run(); err != nil {
		return fmt.Errorf("%w (see %s)", err, logPath(s.name))
	}
	return nil
}

const envFilePath = "/etc/platform/.env"

// childEnviron drops variables that the saved .env defines. config.Load never
// overrides an existing env var with the file's value, so an inherited stale
// value (e.g. a DOMAIN changed at the interactive prompt, or a secret generated
// this run) would otherwise beat what the parent just saved.
func childEnviron(environ []string, fileKeys map[string]bool) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		if fileKeys[k] || k == childEnv {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func envFileKeys(path string) map[string]bool {
	keys := map[string]bool{}
	data, err := os.ReadFile(path)
	if err != nil {
		return keys
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, _, ok := strings.Cut(line, "="); ok && strings.TrimSpace(k) != "" {
			keys[strings.TrimSpace(k)] = true
		}
	}
	return keys
}

func printLogTail(path string, n int) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > n {
			lines = lines[1:]
		}
	}
	color.Red("    ── last %d lines of %s ──", len(lines), path)
	for _, l := range lines {
		fmt.Printf("    %s\n", l)
	}
}
