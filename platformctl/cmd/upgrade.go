package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/components"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/helm"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/upgrade"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
	"github.com/spf13/cobra"
)

var upgradeTo, applyFrom string
var upgradeYes, upgradeDry, upgradeHistory, upgradePatch, upgradeRestore bool

const upgradeState = "/var/lib/platformctl/state/upgrade-history.json"

// Every command is bounded, including kubectl exec health requests.
var upgradeRun = func(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, name, args...)
	b, e := c.CombinedOutput()
	if e != nil {
		return "", fmt.Errorf("%s failed: %w: %s", name, e, b)
	}
	return strings.TrimSpace(string(b)), nil
}

func uk(args ...string) (string, error) { return upgradeRun("kubectl", args...) }

func init() {
	c := &cobra.Command{Use: "upgrade", Short: "Upgrade a release with backup, health gates and rollback", Args: cobra.NoArgs, RunE: runUpgrade}
	c.Flags().StringVar(&upgradeTo, "to", "", "target release (default latest stable)")
	c.Flags().StringVar(&applyFrom, "apply-from", "", "internal target-binary handoff")
	_ = c.Flags().MarkHidden("apply-from")
	c.Flags().BoolVar(&upgradeYes, "yes", false, "confirm the displayed release plan")
	c.Flags().BoolVar(&upgradeDry, "dry-run", false, "show plan without changing the install")
	c.Flags().BoolVar(&upgradePatch, "patch-only", false, "allow stable patches in the installed minor only")
	c.Flags().BoolVar(&upgradeHistory, "history", false, "print local upgrade history")
	c.Flags().BoolVar(&upgradeRestore, "restore-failed-migration", false, "explicitly permit restoring configured PostgreSQL backup after an irreversible migration fails; age identity on stdin")
	rootCmd.AddCommand(c)
}
func runUpgrade(cmd *cobra.Command, _ []string) error {
	if !upgradeHistory {
		if _, e := upgrade.Parse(Version); e != nil {
			return fmt.Errorf("this platformctl was not built as a release; install a release binary (install.sh) to use upgrade")
		}
	}
	hostKubeconfig()
	if upgradeHistory {
		h, e := upgrade.ReadHistory(upgradeState)
		if e != nil {
			return e
		}
		return json.NewEncoder(cmd.OutOrStdout()).Encode(h)
	}
	current := Version
	if _, e := upgrade.Parse(cfg.ImageTag); e == nil {
		current = cfg.ImageTag
	}
	history, e := upgrade.ReadHistory(upgradeState)
	if e != nil {
		return e
	}
	for _, record := range history {
		if record.Status == "succeeded" {
			current = record.To
		}
	}
	if applyFrom != "" {
		current = applyFrom
	}
	var r upgrade.Release
	if upgradePatch && upgradeTo == "" {
		r, e = upgrade.PatchMetadata(current)
	} else {
		r, e = upgrade.Metadata(upgradeTo)
	}
	if e != nil {
		return e
	}
	if e = upgrade.Compatible(current, r.Tag, r.Rules, upgradePatch); e != nil {
		return e
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Upgrade %s -> %s\n%s\nBreaking notes: %s\n", current, r.Tag, r.Notes, r.Rules.BreakingNotes)
	if applyFrom == "" && strings.TrimPrefix(Version, "v") != strings.TrimPrefix(r.Tag, "v") {
		dir, e := os.MkdirTemp("", "platformctl-upgrade-")
		if e != nil {
			return e
		}
		defer os.RemoveAll(dir)
		binary, e := upgrade.Download(r.Tag, dir)
		if e != nil {
			return e
		}
		args := []string{"upgrade", "--to", r.Tag, "--apply-from", current}
		if upgradeYes {
			args = append(args, "--yes")
		}
		if upgradeDry {
			args = append(args, "--dry-run")
		}
		if upgradePatch {
			args = append(args, "--patch-only")
		}
		if upgradeRestore {
			args = append(args, "--restore-failed-migration")
		}
		child := exec.Command(binary, args...)
		child.Stdin = cmd.InOrStdin()
		child.Stdout = cmd.OutOrStdout()
		child.Stderr = cmd.ErrOrStderr()
		return child.Run()
	}
	if strings.TrimPrefix(Version, "v") != strings.TrimPrefix(r.Tag, "v") {
		return fmt.Errorf("target binary version does not match release")
	}
	unlock, e := state.AcquireLock("upgrade")
	if e != nil {
		return e
	}
	defer unlock()
	if e = upgradePreflight(); e != nil {
		return fmt.Errorf("preflight refused upgrade: %w", e)
	}
	if e = components.SyncCredentialsFromCluster(cfg); e != nil {
		return fmt.Errorf("read current cluster credentials before taking database backup: %w", e)
	}
	cfg.ImageTag = strings.TrimPrefix(r.Tag, "v")
	api, portal, e := components.ResolveUpgradeImages(cfg)
	if e != nil {
		return e
	}
	plan, e := upgradePlan(api, portal)
	if e != nil {
		return e
	}
	b, _ := json.MarshalIndent(plan, "", "  ")
	fmt.Fprintf(cmd.OutOrStdout(), "Plan: backup -> target migrations -> changed charts (atomic) -> images -> health gates\n%s\n", b)
	if upgradeDry {
		return nil
	}
	if len(plan.Charts) == 0 && len(plan.Images) == 0 && strings.TrimPrefix(current, "v") == strings.TrimPrefix(r.Tag, "v") {
		fmt.Fprintln(cmd.OutOrStdout(), "Already at the requested release and pins.")
		resume, e := suspendUpgradeUpdater()
		if e != nil {
			return e
		}
		if e = finishUpgradeInstallation(); e != nil {
			if re := resume(); re != nil {
				return fmt.Errorf("%w; resume updater: %v", e, re)
			}
			return e
		}
		return resume()
	}
	reader := bufio.NewReader(cmd.InOrStdin())
	if !upgradeYes {
		fmt.Fprint(cmd.OutOrStdout(), "Apply this upgrade? [y/N] ")
		line, _ := reader.ReadString('\n')
		if strings.TrimSpace(strings.ToLower(line)) != "y" {
			return fmt.Errorf("upgrade cancelled")
		}
	}
	resumeUpdater, e := suspendUpgradeUpdater()
	if e != nil {
		return e
	}
	completed := false
	defer func() {
		if !completed {
			if e := resumeUpdater(); e != nil {
				fmt.Fprintln(cmd.ErrOrStderr(), "could not restore auto-update schedule:", e)
			}
		}
	}()
	var backupID string
	h := upgrade.Hooks{
		Backup: func() (string, error) { var e error; backupID, e = upgradeBackup(current); return backupID, e },
		Migrate: func() error {
			e := components.RunAPIMigrations(cfg, api)
			if e == nil || !r.Rules.Irreversible {
				return e
			}
			if !upgradeRestore {
				if upgradeYes {
					return fmt.Errorf("%w; irreversible migration failed; restore requires --restore-failed-migration and an age identity", e)
				}
				fmt.Fprint(cmd.OutOrStdout(), "Irreversible migration failed. Restore PostgreSQL from the pre-upgrade backup? [y/N] ")
				line, _ := reader.ReadString('\n')
				if strings.TrimSpace(strings.ToLower(line)) != "y" {
					return e
				}
			}
			bc, ce := backup.ReadConfig("/etc/platform/backup.json")
			if ce != nil {
				if os.IsNotExist(ce) {
					resume, re := (backup.HostDriver{}).Quiesce()
					if re != nil {
						return fmt.Errorf("%w; stop API writers before database restore: %v", e, re)
					}
					re = components.RestoreUpgradeDatabase(cfg, backupID)
					resumeErr := resume()
					if re != nil || resumeErr != nil {
						return fmt.Errorf("%w; local database restore=%v; resume API=%v", e, re, resumeErr)
					}
					if re = upgradeHealth(); re != nil {
						return fmt.Errorf("%w; local dump restored but recovery health failed: %v", e, re)
					}
					return fmt.Errorf("%w; pre-upgrade local database dump restored", e)
				}
				return fmt.Errorf("%w; encrypted restore unavailable: %v; use the recorded local dump with the recovery runbook", e, ce)
			}
			fmt.Fprintln(cmd.ErrOrStderr(), "Reading the backup age identity from stdin (finish with EOF).")
			identity, ce := readIdentity(reader)
			if ce != nil {
				return fmt.Errorf("%w; restore identity: %v", e, ce)
			}
			defer clear(identity)
			ce = backup.Restore(bc.Target, backupID, "postgres", identity, backup.HostDriver{MinioAlias: bc.MinioAlias})
			if ce != nil {
				return fmt.Errorf("%w; database restore failed: %v", e, ce)
			}
			if ce = upgradeHealth(); ce != nil {
				return fmt.Errorf("%w; database restored but recovery health failed: %v", e, ce)
			}
			return fmt.Errorf("%w; pre-upgrade PostgreSQL backup restored", e)
		},
		Chart: func(c upgrade.Chart) error {
			pin := versions.Get(c.Chart)
			if e := helm.CacheChart(pin); e != nil {
				return e
			}
			_, e := upgradeRun("helm", "upgrade", c.Name, pin.CacheFile(), "-n", c.Namespace, "--reuse-values", "--atomic", "--timeout", "10m")
			return e
		},
		RollbackChart: func(c upgrade.Chart) error {
			_, e := upgradeRun("helm", "rollback", c.Name, strconv.Itoa(c.Revision), "-n", c.Namespace, "--wait", "--timeout", "10m")
			return e
		},
		Image: func(i upgrade.Image, rollback bool) error {
			image := i.After
			if rollback {
				image = i.Before
			}
			_, e := uk("-n", "platform", "set", "image", "deployment/"+i.Deployment, i.Container+"="+image)
			return e
		},
		Health: upgradeHealth,
		Save:   saveUpgradeHistory,
	}
	if e = upgrade.Apply(upgrade.Record{From: current, To: r.Tag, Plan: plan}, h); e != nil {
		return e
	}
	if e = finishUpgradeInstallation(); e != nil {
		return e
	}
	if e = resumeUpdater(); e != nil {
		return fmt.Errorf("release is healthy; resume digest-refresh schedule: %w", e)
	}
	completed = true
	return nil
}

func finishUpgradeInstallation() error {
	executable, e := os.Executable()
	if e != nil {
		return e
	}
	if e = upgrade.InstallBinary(executable, "/usr/local/bin/platformctl"); e != nil {
		return fmt.Errorf("release is healthy; install target platformctl in /usr/local/bin before enabling auto-update: %w", e)
	}
	if e = components.InstallAutoUpdate(cfg); e != nil {
		return fmt.Errorf("release is healthy; auto-update schedule needs repair: %w", e)
	}
	return nil
}

// Only legacy digest-only schedules bypass the provision lock. Suspend them
// before taking the backup; schedules already using upgrade share our lock.
func suspendUpgradeUpdater() (func() error, error) {
	raw, e := uk("-n", "platform", "get", "cronjob", "platform-auto-update", "--ignore-not-found", "-o", "json")
	if e != nil {
		return nil, e
	}
	if raw == "" {
		return func() error { return nil }, nil
	}
	type jobSpec struct {
		Template struct {
			Spec struct{ Containers []struct{ Command []string } }
		}
	}
	var cron struct {
		Spec struct {
			Suspend     bool
			JobTemplate struct{ Spec jobSpec }
		}
		Status struct{ Active []json.RawMessage }
	}
	if e = json.Unmarshal([]byte(raw), &cron); e != nil {
		return nil, e
	}
	for _, c := range cron.Spec.JobTemplate.Spec.Template.Spec.Containers {
		for _, arg := range c.Command {
			if arg == "--patch-only" {
				return func() error { return nil }, nil
			}
		}
	}
	if len(cron.Status.Active) > 0 {
		return nil, fmt.Errorf("wait for the active legacy platform-auto-update Job to finish before upgrading")
	}
	prior := cron.Spec.Suspend
	resume := func() error {
		_, e := uk("-n", "platform", "patch", "cronjob", "platform-auto-update", "--type=merge", "-p", fmt.Sprintf(`{"spec":{"suspend":%t}}`, prior))
		return e
	}
	if _, e = uk("-n", "platform", "patch", "cronjob", "platform-auto-update", "--type=merge", "-p", `{"spec":{"suspend":true}}`); e != nil {
		return nil, e
	}
	raw, e = uk("-n", "platform", "get", "cronjob", "platform-auto-update", "-o", "json")
	if e == nil {
		e = json.Unmarshal([]byte(raw), &cron)
	}
	if e != nil || len(cron.Status.Active) > 0 {
		re := resume()
		return nil, fmt.Errorf("auto-update raced suspension; wait and retry (read=%v, resume=%v)", e, re)
	}
	return resume, nil
}
func upgradePlan(api, portal string) (upgrade.Plan, error) {
	raw, e := upgradeRun("helm", "list", "-A", "-o", "json")
	if e != nil {
		return upgrade.Plan{}, e
	}
	var releases []struct{ Name, Namespace, Chart, Revision string }
	if e = json.Unmarshal([]byte(raw), &releases); e != nil {
		return upgrade.Plan{}, e
	}
	var installed []upgrade.Chart
	pins := map[string]string{}
	for _, p := range versions.All() {
		pins[p.Name] = p.Version
		for _, r := range releases {
			// Exact chart-name match: a "loki-" prefix also matches
			// "loki-stack-2.10.3", and upgrading that release to the loki chart
			// with --reuse-values fails (and would discard its data). The
			// loki-stack -> loki move is a migration done by the telemetry step.
			name, version, ok := versions.SplitChartRef(r.Chart)
			if !ok || name != p.BaseName() {
				continue
			}
			rev, e := strconv.Atoi(r.Revision)
			if e != nil || rev < 1 {
				return upgrade.Plan{}, fmt.Errorf("invalid Helm revision")
			}
			installed = append(installed, upgrade.Chart{Name: r.Name, Namespace: r.Namespace, Chart: p.Name, Version: version, Revision: rev})
		}
	}
	var images []upgrade.Image
	for _, x := range []struct{ d, c, target string }{{"platform-api", "api", api}, {"platform-portal", "portal", portal}} {
		old, e := uk("-n", "platform", "get", "deployment", x.d, "-o", "jsonpath={.spec.template.spec.containers[?(@.name=='"+x.c+"')].image}")
		if e != nil {
			return upgrade.Plan{}, e
		}
		if old == "" {
			return upgrade.Plan{}, fmt.Errorf("missing %s image", x.d)
		}
		if !strings.Contains(old, "@sha256:") {
			return upgrade.Plan{}, fmt.Errorf("%s uses a mutable tag; run platformctl update to pin images before a release upgrade", x.d)
		}
		images = append(images, upgrade.Image{Deployment: x.d, Container: x.c, Before: old, After: x.target})
	}
	return upgrade.Compute(installed, pins, images), nil
}
func upgradePreflight() error {
	out, e := upgradeRun("sh", "-c", `df -Pk /var/lib | awk 'NR==2 {print $4}'; awk '/MemAvailable:/ {print $2}' /proc/meminfo`)
	if e != nil {
		return e
	}
	f := strings.Fields(out)
	if len(f) != 2 {
		return fmt.Errorf("cannot determine disk/RAM headroom")
	}
	disk, de := strconv.ParseInt(f[0], 10, 64)
	ram, re := strconv.ParseInt(f[1], 10, 64)
	if de != nil || re != nil || disk < 2*1024*1024 || ram < 512*1024 {
		return fmt.Errorf("free at least 2 GiB under /var/lib and 512 MiB available RAM")
	}
	for _, ns := range []string{"platform", "databases", "storage"} {
		raw, e := uk("-n", ns, "get", "pods", "-o", "json")
		if e != nil {
			return e
		}
		if e = healthyPods([]byte(raw)); e != nil {
			return fmt.Errorf("repair pods in %s first: %w", ns, e)
		}
	}
	if e = checkActiveOperations(); e != nil {
		return e
	}
	if _, e = os.Stat("/etc/platform/backup.json"); e == nil {
		bc, e := backup.ReadConfig("/etc/platform/backup.json")
		if e != nil {
			return e
		}
		if e = bc.Validate(); e != nil {
			return e
		}
		t, e := backup.ParseTarget(bc.Target)
		if e != nil {
			return e
		}
		_, e = (backup.Store{Target: t}).List()
		if e != nil {
			return fmt.Errorf("backup target unreachable: %w", e)
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	return nil
}
func healthyPods(raw []byte) error {
	var list struct {
		Items []struct {
			Metadata struct{ Name string }
			Status   struct {
				Phase      string
				Conditions []struct{ Type, Status string }
			}
		}
	}
	if e := json.Unmarshal(raw, &list); e != nil {
		return e
	}
	for _, p := range list.Items {
		if p.Status.Phase == "Succeeded" {
			continue
		}
		ready := false
		for _, c := range p.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				ready = true
			}
		}
		if p.Status.Phase != "Running" || !ready {
			return fmt.Errorf("pod %s is not Ready", p.Metadata.Name)
		}
	}
	return nil
}

func upgradeBackup(source string) (string, error) {
	if _, e := os.Stat("/etc/platform/backup.json"); e == nil {
		c, e := backup.ReadConfig("/etc/platform/backup.json")
		if e != nil {
			return "", e
		}
		warnLocal(c)
		if e = backup.CheckTools(captureTools(c)); e != nil {
			return "", e
		}
		m, e := backup.Create(c, source, backup.HostDriver{MinioAlias: c.MinioAlias})
		return m.ID, e
	} else if !os.IsNotExist(e) {
		return "", e
	}
	fmt.Fprintln(os.Stderr, "WARNING: backups are not configured; taking a LOCAL ONLY database and credentials backup; this does not protect against disk loss.")
	return components.BackupPlatformDatabase(cfg, os.Getenv("PLATFORMCTL_BACKUP_ROOT"))
}
func upgradeHealth() error {
	for _, d := range []string{"platform-api", "platform-portal"} {
		if _, e := uk("-n", "platform", "rollout", "status", "deploy/"+d, "--timeout=300s"); e != nil {
			return e
		}
	}
	installed, e := uk("-n", "argocd", "get", "service", "argocd-server", "--ignore-not-found", "-o", "name")
	if e != nil {
		return e
	}
	for _, probe := range upgradeHealthProbes(installed != "") {
		var last error
		for i := 0; i < 12; i++ {
			_, last = uk("-n", "platform", "exec", "deploy/platform-api", "-c", "api", "--", "node", "-e", healthProbeScript, probe.URL, probe.On404)
			if last == nil {
				break
			}
			time.Sleep(5 * time.Second)
		}
		if last != nil {
			return fmt.Errorf("endpoint %s: %w", probe.URL, last)
		}
	}
	return nil
}

// healthProbe is one in-cluster endpoint that must answer 200 after an upgrade
// and after a rollback. On404 handles endpoints an older release lacks (the
// rollback target, e.g. v1.2.0): "" means 404 fails, "skip" accepts it, and a
// URL is probed instead (and must answer 200).
type healthProbe struct{ URL, On404 string }

// healthProbeScript runs inside the API container (node is always there):
// argv[1] = URL, argv[2] = On404.
const healthProbeScript = `(async()=>{const get=u=>fetch(u,{signal:AbortSignal.timeout(15000)});let r=await get(process.argv[1]);const f=process.argv[2]||"";if(r.status===404&&f==="skip")return;if(r.status===404&&f)r=await get(f);if(r.status!==200){console.error(r.url+" answered "+r.status);process.exit(1)}})().catch(e=>{console.error(String(e));process.exit(1)})`

const apiInternal = "http://platform-api.platform.svc.cluster.local:3000"

// upgradeHealthProbes lists the gate endpoints. /api/health/schema proves the
// database schema matches the API (a rolled-back schema with dropped columns
// passes /api/health/ready but fails every project query). Argo CD is served
// under a root path (/argocd), so its "/" is 404; /healthz answers regardless.
func upgradeHealthProbes(argoInstalled bool) []healthProbe {
	probes := []healthProbe{
		{URL: apiInternal + "/api/health/ready", On404: apiInternal + "/api/health"},
		{URL: apiInternal + "/api/health/schema", On404: "skip"},
		{URL: "http://platform-portal.platform.svc.cluster.local"},
		{URL: apiInternal + "/api/oauth/.well-known/openid-configuration"},
	}
	if argoInstalled {
		probes = append(probes, healthProbe{URL: "http://argocd-server.argocd.svc.cluster.local/healthz"})
	}
	return probes
}

func saveUpgradeHistory(r upgrade.Record) error {
	b, e := upgrade.AppendHistory(upgradeState, r)
	if e != nil {
		return e
	}
	// ConfigMaps are limited to 1 MiB. Keep the complete local audit log and
	// publish only its most recent events once the mirror approaches that cap.
	var recent []upgrade.Record
	if e = json.Unmarshal(b, &recent); e != nil {
		return e
	}
	for len(b) > 800*1024 && len(recent) > 1 {
		recent = recent[1:]
		b, e = json.Marshal(recent)
		if e != nil {
			return e
		}
	}
	manifest, _ := json.Marshal(map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]string{"name": "platform-upgrade-history", "namespace": "platform"}, "data": map[string]string{"history.json": string(b)}})
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "kubectl", "apply", "--server-side", "--field-manager=platformctl-upgrade", "-f", "-")
	c.Stdin = strings.NewReader(string(manifest))
	out, e := c.CombinedOutput()
	if e != nil {
		return fmt.Errorf("publish history ConfigMap: %w: %s", e, out)
	}
	return nil
}
