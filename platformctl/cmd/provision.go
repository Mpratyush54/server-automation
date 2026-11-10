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
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/ocifetch"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/preflight"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/runner"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/stack"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

// childEnv marks a platformctl process started by provision to run one step.
// Children skip the provision lock (the parent holds it).
const childEnv = "PLATFORMCTL_CHILD"

// defaultParallel is how many cluster steps run at once. With images preloaded
// from the platform stack the steps are mostly waiting on pod starts, so all
// first-wave steps start at once and a minimum-spec box (4 cores / 8 GB) stays
// responsive.
const defaultParallel = 8

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
	// Ready steps start in this order, so the critical path comes first:
	// databases -> platform -> routing, plus Portainer (slowest to become ready).
	return []stepDef{
		{name: "postgresql", args: install("postgresql"), fn: components.InstallPostgreSQL},
		{name: "mongodb", args: install("mongodb"), fn: components.InstallMongoDB},
		{name: "redis", args: install("redis"), fn: components.InstallRedis},
		{name: "minio", args: install("minio"), fn: components.InstallMinIO},
		{name: "ingress-nginx", args: install("ingress-nginx"), fn: components.InstallIngressNginx},
		{name: "cert-manager", skip: !c.InstallCertManager, args: install("cert-manager"), fn: components.InstallCertManager},
		{name: "portainer", skip: !c.InstallPortainer, args: install("portainer"), fn: components.InstallPortainer},
		{name: "argocd", skip: !c.InstallArgoCD, args: install("argocd"), fn: components.InstallArgoCD},
		{name: "monitoring", skip: !c.InstallMonitoring, args: install("monitoring"), fn: components.InstallMonitoring},
		// Kyverno is opt-in (full + INSTALL_KYVERNO); skipped nodes satisfy deps.
		{name: "kyverno", skip: !c.InstallKyverno, args: install("kyverno"), fn: components.InstallKyverno},
		{name: "platform", deps: []string{"postgresql", "mongodb", "redis", "minio", "kyverno"},
			args: install("platform"), fn: components.InstallPlatform},
		// Ingresses (and so the TLS certificate request) right after the ingress
		// controller and cert-manager: the certificate issues in parallel with
		// the databases and the platform instead of at the end.
		{name: "ingress", deps: []string{"ingress-nginx", "cert-manager"},
			args: install("ingress"), fn: components.InstallIngress, warnOnly: true},
		// Routing creates every Ingress (backends may still be starting) and
		// patches Argo CD; it does not wait for monitoring or Portainer, which
		// finish on their own. That kept ~1 minute off the critical path.
		{name: "routing", deps: []string{
			"ingress-nginx", "cert-manager", "platform", "argocd", "minio", "ingress",
		}, args: install("routing"), fn: components.InstallRouting},
		// oauth2-proxy discovers OIDC at https://DOMAIN/api/oauth, which only exists
		// once routing has created the platform Ingress, so it runs after routing.
		{name: "oauth2-proxy", deps: []string{"routing"}, args: install("oauth2-proxy"), fn: components.InstallOAuthProxy},
		{name: "auto-update", deps: []string{"argocd", "platform"}, skip: !c.AutoUpdate,
			args: install("auto-update"), fn: components.InstallAutoUpdate},
		{name: "telemetry", deps: []string{"platform", "monitoring", "routing"}, skip: !components.FullTelemetry(c), args: install("telemetry"), fn: components.InstallTelemetry},
		{name: "seed", deps: []string{"platform"}, args: []string{"seed"}, fn: components.SeedAdmin, warnOnly: true},
		// MinIO IAM needs the platform API (its OpenID issuer), so the API's scoped
		// storage user is created after "platform"; the API restarts with it.
		{name: "storage-scoped", deps: []string{"platform", "minio"}, args: install("storage-scoped"), fn: components.SetupBundledStorage},
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
		hardeningPreflight()
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
	// The platform stack (every third-party image, chart and k3s in one GHCR
	// artifact) downloads while the prerequisites install. It must land
	// before k3s starts, which imports the image tarballs at start-up.
	stackDone := startStackDownload()
	// Prerequisites (apt) are only needed by the cluster steps, not by helm or
	// k3s: install them in the background too, and wait before the cluster steps.
	prereqsDone := make(chan error, 1)
	go func() {
		_ = state.MarkInProgress("prereqs")
		track := state.Track("prereqs (background)")
		err := apt.InstallPrereqs()
		if err != nil {
			track("failed")
		} else {
			track("ok")
		}
		prereqsDone <- err
	}()
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

	waitForStack(stackDone)

	// Charts missing from the stack (or without one) download while k3s
	// installs; with the stack this is a no-op.
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
	// Load the stack's images into containerd in parallel before any workload
	// starts. Not fatal: pods pull missing images from their registries.
	importImagesFromStack(stackDone)

	// ── Wave 1: cluster basics.
	if err := hostStep("namespaces", components.Namespace); err != nil {
		return err
	}
	if err := <-prereqsDone; err != nil {
		return fail("prereqs", err)
	}
	// Host hardening (packages, SSH, fail2ban, chrony) runs alongside the
	// cluster install; only the firewall step waits for the platform below.
	hardenPrepared := startHardenPrepare()
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
	// The firewall goes last: its automatic confirmation checks live local
	// ports and the API through ingress (rollback timer armed meanwhile).
	if !cfg.SkipHardening {
		if err := <-hardenPrepared; err != nil {
			return fail("harden", err)
		}
		if err := hostStep("harden-firewall", hardenFirewall); err != nil {
			return err
		}
	}
	printTimings(started)
	components.ProvisionComplete(cfg)
	return nil
}

// stackParallel is how many stack files download at once.
const stackParallel = 8

// startStackDownload installs the platform stack in the background unless an
// offline bundle was given, PLATFORM_STACK=off, it is already installed, or
// k3s is already running (its images directory is only read at start-up).
// The channel or version comes from PLATFORM_STACK (default "stable").
//
// It is a pipeline: the small base files (k3s, charts) come first so k3s can
// start while the image tarballs are still downloading, and each tarball is
// imported as soon as it arrives (importImagesFromStack).
func startStackDownload() *stack.Download {
	tag := stack.Tag(os.Getenv("PLATFORM_STACK"), runtime.GOARCH)
	if bundleFlag != "" || tag == "" || state.IsDone("platform-stack") || k3s.IsInstalled() {
		return nil
	}
	color.Cyan("  ■ Downloading the platform stack %s:%s in the background...", stack.Repo, tag)
	return stack.Start(ocifetch.New("ghcr.io"), tag, stack.DefaultPaths, stackParallel)
}

// waitForStack blocks until the stack's base files (k3s, charts) are in
// place. A failure is not fatal: k3s, charts and images are then downloaded
// individually, as before.
func waitForStack(dl *stack.Download) {
	if dl == nil {
		return
	}
	track := state.Track("platform-stack base (k3s, charts)")
	if err := <-dl.Base; err != nil {
		track("failed")
		color.Yellow("  ⚠ platform stack unavailable (%v); k3s, charts and images will be downloaded individually", err)
		return
	}
	track("ok")
}

// importParallel is how many image tarballs load into containerd at once.
const importParallel = 4

// importImagesFromStack imports the stack's image tarballs as they finish
// downloading, then reports the whole download. Not fatal: pods pull any
// missing image from its registry.
func importImagesFromStack(dl *stack.Download) {
	if dl == nil {
		return
	}
	track := state.Track("image download + import (overlapped)")
	n, ierr := stack.ImportFrom(dl.Images, importParallel)
	res, derr := dl.Wait()
	switch {
	case derr != nil:
		track("partial")
		color.Yellow("  ⚠ %v; missing images will be pulled from their registries", derr)
	case ierr != nil:
		track("partial")
		color.Yellow("  ⚠ %v; missing images will be pulled from their registries", ierr)
	default:
		track("ok")
		_ = state.MarkDone("platform-stack")
		color.Green("  ✓ Platform stack %s (%s): %d files, %.1f GB downloaded in %.0fs, %d image archive(s) imported",
			res.Version, shortDigest(res.Digest), res.Files, float64(res.Bytes)/1e9, res.Seconds, n)
	}
}

func shortDigest(d string) string {
	if len(d) > 19 {
		return d[:19]
	}
	return d
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
				// Components record their own progress under their own state keys
				// (e.g. "ingress", not "ingress-nginx"); writing the graph node name
				// here left stale "in_progress" entries that never cleared.
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
