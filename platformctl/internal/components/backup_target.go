package components

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/backup"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/fatih/color"
)

// External backup target (#186). The target's credentials only ever travel
// as JSON on kubectl's standard input; they are not written to the host, put
// on a command line, or printed.

// LocalOnlyWarning is the persistent warning shown everywhere when backups
// stay on the server.
const LocalOnlyWarning = "Backups are stored only on this server. If the server or its disk is lost, the backups are lost too. Add an off-site target: sudo platformctl backup target set (see docs/operations/backups.md)"

// Replaceable in tests.
var (
	kubeApplyJSON = applyTelemetryJSON
	kubeSecret    = readKubeSecret
	probeTarget   = func(t backup.S3Target) error {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		return backup.NewS3Client(t).Probe(ctx)
	}
	kubeNamespaceExists = func(ns string) bool {
		return shell.RunSilent("kubectl", "get", "namespace", ns) == nil
	}
)

// readKubeSecret decodes a Secret's data in Go (no base64 on the host shell).
func readKubeSecret(ns, name string) (map[string]string, error) {
	c := exec.Command("kubectl", "-n", ns, "get", "secret", name, "-o", "json")
	out, err := c.Output()
	if err != nil {
		return nil, fmt.Errorf("Secret %s/%s not readable", ns, name)
	}
	var s struct {
		Data map[string]string `json:"data"`
	}
	if err := json.Unmarshal(out, &s); err != nil {
		return nil, err
	}
	m := map[string]string{}
	for k, v := range s.Data {
		b, err := base64.StdEncoding.DecodeString(v)
		if err != nil {
			return nil, fmt.Errorf("Secret %s/%s is malformed", ns, name)
		}
		m[k] = string(b)
	}
	return m, nil
}

// BackupTargetFromConfig builds the target from the saved settings and the
// credentials given for this run.
func BackupTargetFromConfig(cfg *config.Config) backup.S3Target {
	b := cfg.Backup
	return backup.S3Target{Endpoint: b.Endpoint, Bucket: b.Bucket, Region: b.Region, Prefix: b.Prefix, AccessKey: b.AccessKey, SecretKey: b.SecretKey}.Normalize()
}

// ProbeBackupTarget validates and probes the target with a real write, read
// and delete. Errors are plain sentences without credentials.
func ProbeBackupTarget(t backup.S3Target) error {
	if err := t.Validate(); err != nil {
		return err
	}
	return probeTarget(t)
}

// ReadBackupTarget loads the target, credentials included, from its Secret.
func ReadBackupTarget() (backup.S3Target, error) {
	d, err := kubeSecret("platform", backup.TargetSecret)
	if err != nil {
		return backup.S3Target{}, fmt.Errorf("no external backup target is stored in the cluster (%v); run: sudo platformctl backup target set", err)
	}
	t := backup.TargetFromSecretData(d)
	return t, t.Validate()
}

// ApplyBackupTarget writes the target Secrets for every consumer and the
// non-secret summary the API reads. ha adds the etcd and Longhorn copies.
func ApplyBackupTarget(cfg *config.Config, t backup.S3Target) error {
	if err := t.Validate(); err != nil {
		return err
	}
	secrets := []struct {
		ns, name string
		data     map[string]string
	}{
		{"platform", backup.TargetSecret, t.SecretData()},
		{"databases", backup.PostgresTargetSecret, t.PostgresSecretData()},
	}
	if cfg.IsHA() {
		secrets = append(secrets,
			struct {
				ns, name string
				data     map[string]string
			}{"kube-system", backup.EtcdTargetSecret, t.EtcdSecretData()},
			struct {
				ns, name string
				data     map[string]string
			}{LonghornNamespace, backup.LonghornTargetSecret, t.LonghornSecretData()})
		// Longhorn's namespace is created by its chart; create it early so the
		// credential Secret can exist before the first install.
		if !kubeNamespaceExists(LonghornNamespace) {
			if err := kubeApplyJSON(map[string]any{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]string{"name": LonghornNamespace}}); err != nil {
				return err
			}
		}
	}
	for _, s := range secrets {
		if err := kubeApplyJSON(backup.SecretManifest(s.ns, s.name, s.data)); err != nil {
			return fmt.Errorf("store backup target credentials in %s/%s: %w", s.ns, s.name, err)
		}
	}
	return publishBackupMode(backup.ModeExternal, &t)
}

// publishBackupMode writes the ConfigMap read by the API and the textfile
// metric behind the local-only alert.
func publishBackupMode(mode string, t *backup.S3Target) error {
	cm := map[string]any{"apiVersion": "v1", "kind": "ConfigMap",
		"metadata": map[string]any{"name": backup.TargetConfigMap, "namespace": "platform", "labels": map[string]string{"app.kubernetes.io/part-of": "platform"}},
		"data":     backup.SummaryData(mode, t, time.Now())}
	if err := kubeApplyJSON(cm); err != nil {
		return fmt.Errorf("publish backup target summary: %w", err)
	}
	if err := backup.WriteTargetMetric(backup.MetricsDir, mode == backup.ModeExternal); err != nil {
		color.Yellow("  · backup target metric not written: %v", err)
	}
	return nil
}

// ApplyLocalBackupChoice records an explicit local-only choice.
func ApplyLocalBackupChoice() error { return publishBackupMode(backup.ModeLocal, nil) }

// EnsureBackupTarget is the provision host step after the namespaces exist.
// Credentials given this run are stored; on a re-run without them the
// stored Secret is kept.
func EnsureBackupTarget(cfg *config.Config) error {
	switch {
	case cfg.BackupExternal() && cfg.Backup.HasCredentials():
		if err := ApplyBackupTarget(cfg, BackupTargetFromConfig(cfg)); err != nil {
			return err
		}
		color.Green("  ✓ Backup target stored in Kubernetes Secrets: %s", BackupTargetFromConfig(cfg).Describe())
	case cfg.BackupExternal():
		t, err := ReadBackupTarget()
		if err != nil {
			return fmt.Errorf("backup target credentials are missing: set BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY for this run, or run: sudo platformctl backup target set")
		}
		// Settings in .env win over the stored copy (bucket moved by hand);
		// the stored credentials are reused.
		s := BackupTargetFromConfig(cfg)
		s.AccessKey, s.SecretKey = t.AccessKey, t.SecretKey
		if s != t {
			if err := ApplyBackupTarget(cfg, s); err != nil {
				return err
			}
		} else if err := publishBackupMode(backup.ModeExternal, &t); err != nil {
			return err
		}
		color.Green("  ✓ Backup target: %s", s.Describe())
	default:
		mode := cfg.Backup.Mode
		if mode == "" {
			mode = backup.ModeLocal
		}
		if err := publishBackupMode(mode, nil); err != nil {
			return err
		}
		color.Yellow("  ⚠ %s", LocalOnlyWarning)
	}
	return nil
}

// PrintBackupTargetStatus is the `platformctl status` backup section.
func PrintBackupTargetStatus(w io.Writer, cfg *config.Config) {
	if cfg.BackupExternal() {
		t := BackupTargetFromConfig(cfg)
		fmt.Fprintf(w, "Backups: off-site target %s\n", t.Describe())
		if _, err := kubeSecret("platform", backup.TargetSecret); err != nil {
			color.New(color.FgRed).Fprintf(w, "  WARNING: the target's credential Secret platform/%s is missing; run: sudo platformctl backup target set\n", backup.TargetSecret)
		}
		return
	}
	color.New(color.FgYellow).Fprintf(w, "Backups: WARNING: %s\n", LocalOnlyWarning)
}

// BackupTargetDescription is "" for local-only installs.
func BackupTargetDescription(cfg *config.Config) string {
	if !cfg.BackupExternal() {
		return ""
	}
	return BackupTargetFromConfig(cfg).Describe()
}

// trimLines keeps command output short in error messages.
func trimLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// ApplyBackupAlerts installs the backup PrometheusRule when the monitoring
// CRDs exist (installs without monitoring rely on portal notifications).
func ApplyBackupAlerts() error {
	if shell.RunSilent("kubectl", "get", "crd", "prometheusrules.monitoring.coreos.com") != nil {
		return nil
	}
	if out, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, backup.AlertsYAML); err != nil {
		return fmt.Errorf("%w: %s", err, trimLines(out, 5))
	}
	return nil
}

// ReconfigureBackupConsumers points everything that archives at the current
// target after `backup target set`: the PostgreSQL ObjectStore (and a fresh
// base backup, because the recovery window starts again in the new place),
// Longhorn's backup target and, on ha, k3s etcd snapshots.
func ReconfigureBackupConsumers(cfg *config.Config) error {
	if PostgresUsesCNPG(cfg) && shell.RunSilent("kubectl", "-n", "databases", "get", "clusters.postgresql.cnpg.io", "postgresql") == nil {
		b, err := pgBackupTarget(cfg)
		if err != nil {
			return err
		}
		if cfg.PostgresBackupDestination == "" && !cfg.BackupExternal() {
			if err := pgBundledStorage(cfg, b); err != nil {
				return err
			}
		}
		server, err := pgLiveServerName()
		if err != nil {
			return err
		}
		if err := applyPGBackupStore(cfg, b); err != nil {
			return err
		}
		if err := applyPGCluster(cfg, pgClusterOptions{Backup: b, ServerName: server}); err != nil {
			return err
		}
		m := pgResource("Backup", fmt.Sprintf("postgresql-target-%d", time.Now().Unix()))
		m["spec"] = pgPluginBackupSpec(map[string]any{})
		if err := kubeApplyJSON(m); err != nil {
			return err
		}
		color.Green("  ✓ PostgreSQL now archives to %s; a new base backup was requested", b.Destination)
	}
	if cfg.IsHA() {
		if err := applyLonghornBackups(cfg); err != nil {
			return err
		}
		if cfg.BackupExternal() && cfg.Cluster.EtcdS3Endpoint == "" {
			if err := ensureEtcdS3DropIn(); err != nil {
				return err
			}
		}
	}
	return nil
}

// K3sConfigDir holds k3s config drop-ins; a variable for tests.
var K3sConfigDir = "/etc/rancher/k3s"

// etcdS3DropIn turns on etcd snapshot uploads with the credential Secret.
const etcdS3DropIn = "# Managed by platformctl (#186): etcd snapshots to the off-site backup target.\netcd-s3: true\netcd-s3-config-secret: \"" + backup.EtcdTargetSecret + "\"\n"

// ensureEtcdS3DropIn adds the drop-in on servers installed before #186. k3s
// reads it at its next start.
func ensureEtcdS3DropIn() error {
	main, _ := os.ReadFile(filepath.Join(K3sConfigDir, "config.yaml"))
	if strings.Contains(string(main), "etcd-s3") {
		return nil
	}
	dir := filepath.Join(K3sConfigDir, "config.yaml.d")
	path := filepath.Join(dir, "60-platform-etcd-s3.yaml")
	if b, err := os.ReadFile(path); err == nil && string(b) == etcdS3DropIn {
		return nil
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := config.WriteFileSync(path, etcdS3DropIn, 0600); err != nil {
		return err
	}
	color.Yellow("  · etcd snapshots go to the target after k3s restarts: run `sudo systemctl restart k3s` on each server, one at a time (and `sudo platformctl backup target set` there first if it has its own /etc/platform)")
	return nil
}
