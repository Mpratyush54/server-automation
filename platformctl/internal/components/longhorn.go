package components

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/apt"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/fatih/color"
)

const (
	LonghornStorageClass = "longhorn"
	// LonghornMinioStorageClass backs the distributed MinIO drives. Its
	// replica count follows the node count (MinioStorageReplicaCount).
	LonghornMinioStorageClass = "longhorn-minio"
	LocalPathStorageClass     = "local-path"
	LonghornNamespace         = "longhorn-system"
	LocalStorageSkipFile      = "/var/lib/rancher/k3s/server/manifests/local-storage.yaml.skip"
)

// HAStorageClass is a stable helper for Postgres/Mongo/Redis/MinIO HA (#51/#52)
// to set storageClass explicitly. An empty value uses the cluster default/local-path.
func HAStorageClass(cfg *config.Config) string {
	if cfg.IsHA() {
		return LonghornStorageClass
	}
	return ""
}

// LonghornReplicaCount picks the StorageClass replica count from the number of
// schedulable nodes: 3 on three or more nodes, 2 on exactly two. A single node
// still gets 3 so volumes created now gain replicas as nodes join (they run
// degraded until then). An override of 1..3 (LONGHORN_REPLICAS) wins.
func LonghornReplicaCount(nodes, override int) (int, string) {
	if override >= 1 && override <= 3 {
		if override > nodes {
			return override, fmt.Sprintf("volumes stay degraded until %d nodes are schedulable", override)
		}
		return override, ""
	}
	if nodes >= 3 {
		return 3, ""
	}
	if nodes == 2 {
		return 2, "two nodes tolerate one node loss for storage only; etcd quorum needs 3 servers"
	}
	return 3, "volumes run degraded (one replica scheduled) until more nodes join; replicaAutoBalance places the missing replicas when nodes join; re-run platformctl install longhorn after joins to reconcile"
}

var longhornBackupTargetRE = regexp.MustCompile(`^s3://[a-z0-9][a-z0-9.-]*@[a-z0-9-]+/[A-Za-z0-9._/-]*$`)
var longhornSecretRE = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`)

func renderLonghornValues(cfg *config.Config, replicas int) (string, error) {
	values := readManifest("longhorn-values.yaml")
	if values == "" {
		return "", fmt.Errorf("longhorn-values.yaml manifest missing")
	}
	if replicas < 1 || replicas > 3 {
		return "", fmt.Errorf("Longhorn replicas must be 1..3")
	}
	target, secret := cfg.LonghornBackupTarget, cfg.LonghornBackupSecret
	if secret != "" && (len(secret) > 253 || !longhornSecretRE.MatchString(secret)) {
		return "", fmt.Errorf("LONGHORN_BACKUP_SECRET must be a DNS-1123 name")
	}
	for _, label := range strings.Split(secret, ".") {
		if len(label) > 63 {
			return "", fmt.Errorf("LONGHORN_BACKUP_SECRET DNS label exceeds 63 characters")
		}
	}
	if target != "" && (!longhornBackupTargetRE.MatchString(target) || secret == "") {
		return "", fmt.Errorf("LONGHORN_BACKUP_TARGET must be s3://<bucket>@<region>/<path> and requires LONGHORN_BACKUP_SECRET")
	}
	values = strings.ReplaceAll(values, "{{REPLICAS}}", strconv.Itoa(replicas))
	if target != "" {
		values += fmt.Sprintf("\ndefaultBackupStore:\n  backupTarget: %q\n  backupTargetCredentialSecret: %q\n", target, secret)
	}
	return values, nil
}

// MinioStorageReplicaCount picks the Longhorn replica count for the MinIO
// drives from the number of Ready schedulable nodes. MinIO runs 4 drives (one
// per pod). With fewer than 4 nodes some node holds two drives, and losing it
// loses write quorum; a second Longhorn replica lets those volumes attach on
// another node so the pods reschedule and writes resume. With 4 or more nodes
// each drive sits on its own node and erasure coding alone covers a node loss,
// so one replica (next to the pod) avoids storing every object twice more.
func MinioStorageReplicaCount(nodes int) int {
	if nodes >= MinioDrives {
		return 1
	}
	return 2
}

// longhornMinioStorageClassManifest renders the non-default Longhorn
// StorageClass for the MinIO drives with the given replica count.
func longhornMinioStorageClassManifest(replicas int) string {
	return `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ` + LonghornMinioStorageClass + `
  labels:
    app.kubernetes.io/managed-by: platformctl
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "` + strconv.Itoa(replicas) + `"
  dataLocality: best-effort
  staleReplicaTimeout: "30"
  fsType: ext4
  dataEngine: v1
`
}

// minioStorageClassNeedsRecreate reports whether the existing StorageClass
// (current = its numberOfReplicas, "" when absent) must be deleted before
// applying: StorageClass parameters are immutable.
func minioStorageClassNeedsRecreate(current string, replicas int) bool {
	current = strings.TrimSpace(current)
	return current != "" && current != strconv.Itoa(replicas)
}

// applyLonghornMinioStorageClass creates or reconciles the MinIO StorageClass.
// Overridable in tests.
var applyLonghornMinioStorageClass = func(replicas int) error {
	current, err := shell.Output("kubectl", "get", "storageclass", LonghornMinioStorageClass, "--ignore-not-found", "-o", "jsonpath={.parameters.numberOfReplicas}")
	if err != nil {
		return fmt.Errorf("read %s StorageClass: %w: %s", LonghornMinioStorageClass, err, current)
	}
	if minioStorageClassNeedsRecreate(current, replicas) {
		if out, err := shell.Output("kubectl", "delete", "storageclass", LonghornMinioStorageClass); err != nil {
			return fmt.Errorf("recreate %s StorageClass: %w: %s", LonghornMinioStorageClass, err, out)
		}
		color.Yellow("  %s StorageClass now uses %d replica(s) (was %s); existing MinIO volumes keep their replica count, see docs/operations/ha.md#object-storage", LonghornMinioStorageClass, replicas, strings.TrimSpace(current))
	}
	if out, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, longhornMinioStorageClassManifest(replicas)); err != nil {
		return fmt.Errorf("apply %s StorageClass: %w: %s", LonghornMinioStorageClass, err, out)
	}
	return nil
}

func countReadyNodes(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		status := strings.Split(f[1], ",")
		if status[0] == "Ready" && !strings.Contains(f[1], "SchedulingDisabled") {
			n++
		}
	}
	return n
}

func defaultStorageClasses(jsonOut string) ([]string, error) {
	var list struct {
		Items []struct {
			Metadata struct {
				Name        string            `json:"name"`
				Annotations map[string]string `json:"annotations"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(jsonOut), &list); err != nil {
		return nil, err
	}
	var names []string
	for _, item := range list.Items {
		if item.Metadata.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" {
			names = append(names, item.Metadata.Name)
		}
	}
	return names, nil
}

func longhornHelmScript(valuesFile string) string {
	// Quote paths as shell literals, including temporary directories containing apostrophes.
	quoted := "'" + strings.ReplaceAll(valuesFile, "'", "'\"'\"'") + "'"
	return `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
` + helmLockHelper + `
if kubectl get namespace longhorn-system >/dev/null 2>&1; then
  clear_helm_lock longhorn longhorn-system
fi
helm upgrade --install longhorn ` + chart("longhorn") + ` --namespace longhorn-system --create-namespace -f ` + quoted + ` --wait --timeout 15m
`
}

// longhornReadinessScript bounds the entire readiness poll to ten minutes.
const longhornReadinessScript = `set -euo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
timeout 10m bash -c '
until kubectl get csidriver driver.longhorn.io --request-timeout=30s >/dev/null 2>&1 &&
      kubectl get storageclass longhorn --request-timeout=30s >/dev/null 2>&1 &&
      kubectl -n longhorn-system rollout status deploy/csi-provisioner --timeout=30s; do
  sleep 5
done
'
`

// InstallLonghorn installs or reconciles Longhorn on the ha profile and makes
// it the only default StorageClass. It always runs `helm upgrade` with the
// pinned chart (idempotent): this is also the upgrade path and how the replica
// count is reconciled after nodes join.
func InstallLonghorn(cfg *config.Config) error {
	if !cfg.IsHA() {
		color.Yellow("  ○ longhorn skipped (ha profile only; single-node installs keep local-path)")
		return nil
	}
	if err := PrepareLonghornNode(); err != nil {
		return err
	}
	out, err := shell.Output("kubectl", "get", "nodes", "--no-headers")
	if err != nil {
		return fmt.Errorf("count Longhorn nodes: %w: %s", err, out)
	}
	nodes := countReadyNodes(out)
	replicas, warning := LonghornReplicaCount(nodes, cfg.LonghornReplicas)
	if warning != "" {
		color.Yellow("  %s", warning)
	}
	values, err := renderLonghornValues(cfg, replicas)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp("", "longhorn-values-*.yaml")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(values); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := shell.RunBash(longhornHelmScript(f.Name())); err != nil {
		return fmt.Errorf("install Longhorn: %w", err)
	}
	if err := shell.RunBash(longhornReadinessScript); err != nil {
		return fmt.Errorf("Longhorn CSI readiness timed out: %w", err)
	}
	minioReplicas := MinioStorageReplicaCount(nodes)
	if err := applyLonghornMinioStorageClass(minioReplicas); err != nil {
		return err
	}
	// Every k3s server needs this file; otherwise k3s restores local-path's default annotation on restart.
	if err := WriteLocalStorageSkip(""); err != nil {
		return err
	}
	out, err = shell.Output("kubectl", "patch", "storageclass", LocalPathStorageClass, "-p", `{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}`)
	if err != nil && !strings.Contains(out, "(NotFound)") {
		return fmt.Errorf("unset local-path default: %w: %s", err, out)
	}
	out, err = shell.Output("kubectl", "get", "storageclass", "-o", "json")
	if err != nil {
		return fmt.Errorf("verify default StorageClass: %w: %s", err, out)
	}
	defaults, err := defaultStorageClasses(out)
	if err != nil {
		return fmt.Errorf("decode StorageClasses: %w", err)
	}
	if len(defaults) != 1 || defaults[0] != LonghornStorageClass {
		return fmt.Errorf("expected only longhorn as default StorageClass, got %v", defaults)
	}
	color.Green("  ✓ Longhorn installed as default StorageClass (%d replicas); %s for MinIO drives (%d replica(s))", replicas, LonghornMinioStorageClass, minioReplicas)
	return state.MarkDone("longhorn")
}

// InstallLonghornMonitoring applies the Longhorn ServiceMonitor and volume
// alerts once the monitoring stack's CRDs exist (ha profile + monitoring).
func InstallLonghornMonitoring(cfg *config.Config) error {
	if !cfg.IsHA() || !cfg.InstallMonitoring {
		color.Yellow("  ○ longhorn-monitoring skipped (ha profile with monitoring only)")
		return nil
	}
	if err := shell.RunSilent("kubectl", "get", "crd", "servicemonitors.monitoring.coreos.com"); err != nil {
		color.Yellow("  ⚠ longhorn-monitoring skipped: ServiceMonitor CRD missing (install monitoring, then re-run: platformctl install longhorn-monitoring)")
		return nil
	}
	manifest := readManifest("longhorn-monitoring.yaml")
	if manifest == "" {
		return fmt.Errorf("longhorn-monitoring.yaml manifest missing")
	}
	if out, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, manifest); err != nil {
		return fmt.Errorf("apply Longhorn monitoring: %w: %s", err, out)
	}
	color.Green("  ✓ Longhorn ServiceMonitor and volume alerts applied")
	return state.MarkDone("longhorn-monitoring")
}

// PrepareLonghornNode installs Longhorn's node prerequisites and checks that
// iSCSI is usable. Every ha node runs it: the first server from the longhorn
// step, joined servers and agents from `platformctl join` before k3s starts.
func PrepareLonghornNode() error {
	if err := apt.InstallLonghornPrereqs(); err != nil {
		return err
	}
	if !shell.Exists("iscsiadm") {
		return fmt.Errorf("Longhorn preflight: iscsiadm missing from PATH (install open-iscsi)")
	}
	if err := shell.RunSilent("systemctl", "is-active", "--quiet", "iscsid"); err != nil {
		return fmt.Errorf("Longhorn preflight: iscsid must be active: %w", err)
	}
	return nil
}

// LocalStorageSkipContent is the marker written to LocalStorageSkipFile.
const LocalStorageSkipContent = "# HA storage: Longhorn is the default StorageClass.\n"

// WriteLocalStorageSkip writes LocalStorageSkipFile under root ("" = /). Every
// k3s server needs it, including servers joined later; otherwise k3s restores
// local-path's default annotation on restart.
func WriteLocalStorageSkip(root string) error {
	path := LocalStorageSkipFile
	if root != "" {
		path = filepath.Join(root, filepath.FromSlash(LocalStorageSkipFile))
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(LocalStorageSkipContent), 0644)
}
