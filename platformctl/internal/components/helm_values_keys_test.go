package components

import (
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// The ha profile relies on Helm values whose names are easy to get subtly
// wrong (a misspelled key is silently ignored by Helm). The key sets below
// were checked against the values.yaml of the pinned charts:
//
//   - longhorn 1.12.1           (longhorn/longhorn chart/values.yaml @ v1.12.1)
//   - cloudnative-pg 0.29.1     (cloudnative-pg/charts @ cloudnative-pg-v0.29.1)
//   - bitnami minio 17.0.21     (bitnami/charts @ minio/17.0.21)
//   - bitnami mongodb, redis    (bitnami/charts @ mongodb/17.0.2, redis/23.1.3:
//     the newest public sources; the pinned OCI releases mongodb 20.0.17 and
//     redis 28.3.12 have no public source tag)
//
// The tests assert that (1) every key we rely on is present in the values we
// render and (2) we render no key outside the verified set, so a new or
// renamed key must be checked against the chart and added here.

// freeForm are keys whose contents the chart passes through verbatim
// (Kubernetes resource requirements, annotations) and are not chart keys.
var freeForm = []string{"resources", "annotations"}

func leafPaths(m map[string]any, prefix string, out *[]string) {
	for k, v := range m {
		p := k
		if prefix != "" {
			p = prefix + "." + k
		}
		switch sub := v.(type) {
		case map[string]any:
			leafPaths(sub, p, out)
		case map[string]string:
			if isFreeForm(k) {
				*out = append(*out, p)
				continue
			}
			for sk := range sub {
				*out = append(*out, p+"."+sk)
			}
		default:
			*out = append(*out, p)
		}
	}
}

func isFreeForm(key string) bool {
	for _, f := range freeForm {
		if key == f {
			return true
		}
	}
	return false
}

// trimFreeForm cuts a path at its first free-form segment
// ("sentinel.resources.limits.cpu" -> "sentinel.resources").
func trimFreeForm(p string) string {
	parts := strings.Split(p, ".")
	for i, s := range parts {
		if isFreeForm(s) {
			return strings.Join(parts[:i+1], ".")
		}
	}
	return p
}

var yamlKeyRE = regexp.MustCompile(`^(\s*)([A-Za-z0-9_.-]+):(\s|$)`)

// yamlKeyPaths lists the dotted mapping-key paths of a simple values file
// (block mappings only, which is all our embedded values files use).
func yamlKeyPaths(doc string) []string {
	type frame struct {
		indent int
		key    string
	}
	var stack []frame
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(doc, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		indent := len(line) - len(strings.TrimLeft(line, " "))
		for len(stack) > 0 && stack[len(stack)-1].indent >= indent {
			stack = stack[:len(stack)-1]
		}
		if strings.HasPrefix(trimmed, "-") {
			// List item: its contents are data, not chart keys.
			stack = append(stack, frame{indent, ""})
			continue
		}
		m := yamlKeyRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		stack = append(stack, frame{indent, m[2]})
		keys := make([]string, len(stack))
		inList := false
		for i, f := range stack {
			keys[i] = f.key
			inList = inList || f.key == ""
		}
		if !inList {
			out = append(out, strings.Join(keys, "."))
		}
	}
	return out
}

func checkVerifiedKeys(t *testing.T, chart string, rendered []string, verified, required []string) {
	t.Helper()
	ok := map[string]bool{}
	for _, k := range verified {
		ok[k] = true
	}
	have := map[string]bool{}
	for _, p := range rendered {
		p = trimFreeForm(p)
		have[p] = true
		// Intermediate mapping keys are implied by their children.
		parts := strings.Split(p, ".")
		for i := 1; i < len(parts); i++ {
			have[strings.Join(parts[:i], ".")] = true
		}
	}
	var unverified []string
	for p := range have {
		if ok[p] {
			continue
		}
		// Parents of verified keys are fine.
		parent := false
		for v := range ok {
			if strings.HasPrefix(v, p+".") {
				parent = true
				break
			}
		}
		if !parent {
			unverified = append(unverified, p)
		}
	}
	sort.Strings(unverified)
	if len(unverified) > 0 {
		t.Errorf("%s: rendered values use keys not verified against the pinned chart: %v", chart, unverified)
	}
	for _, k := range required {
		if !have[k] {
			t.Errorf("%s: rendered values lack required key %s", chart, k)
		}
	}
}

func TestHAMongoHelmKeysVerified(t *testing.T) {
	r := mongodbRelease(fixedDatastoreCfg(config.ProfileHA))
	var paths []string
	leafPaths(r.Values, "", &paths)
	paths = append(paths, setArgKeys(r.Args)...)
	checkVerifiedKeys(t, "mongodb", paths,
		[]string{"auth.rootPassword", "auth.replicaSetKey", "architecture", "replicaCount", "replicaSetName",
			"arbiter.enabled", "global.defaultStorageClass", "persistence.storageClass", "podAntiAffinityPreset", "pdb.create", "pdb.maxUnavailable",
			"persistence.size", "metrics.enabled", "metrics.resources", "metrics.service.annotations", "updateStrategy.type"},
		[]string{"architecture", "replicaCount", "replicaSetName", "auth.replicaSetKey", "arbiter.enabled", "global.defaultStorageClass", "pdb.maxUnavailable"})
}

func TestHARedisHelmKeysVerified(t *testing.T) {
	r := redisRelease(fixedDatastoreCfg(config.ProfileHA))
	var paths []string
	leafPaths(r.Values, "", &paths)
	paths = append(paths, setArgKeys(r.Args)...)
	checkVerifiedKeys(t, "redis", paths,
		[]string{"auth.password", "architecture", "sentinel.enabled", "sentinel.masterSet", "sentinel.quorum", "sentinel.resources",
			"sentinel.masterService.enabled", "replica.replicaCount", "replica.persistence.size", "replica.persistence.storageClass", "replica.podAntiAffinityPreset",
			"replica.automountServiceAccountToken", "rbac.create", "serviceAccount.automountServiceAccountToken",
			"global.defaultStorageClass", "metrics.enabled", "metrics.resources", "metrics.service.annotations",
			"master.persistence.size"},
		[]string{"architecture", "sentinel.enabled", "sentinel.masterSet", "sentinel.quorum", "sentinel.masterService.enabled",
			"replica.replicaCount", "rbac.create", "auth.password"})
}

func TestHAMinioHelmKeysVerified(t *testing.T) {
	c := fixedDatastoreCfg(config.ProfileHA)
	var paths []string
	leafPaths(minioInstallValues(c), "", &paths)
	paths = append(paths, yamlKeyPaths(readManifest("minio-values.yaml"))...)
	// Keys InstallMinIO passes with --set.
	paths = append(paths, "persistence.size", "image.repository", "console.image.repository", "defaultBuckets")
	checkVerifiedKeys(t, "minio", paths,
		[]string{"auth.rootUser", "auth.rootPassword", "resources", "console.resources", "console.extraEnvVars", "extraEnvVars",
			"ingress.enabled", "mode", "statefulset.replicaCount", "statefulset.drivesPerNode", "statefulset.zones",
			"global.defaultStorageClass", "podAntiAffinityPreset", "pdb.create", "pdb.maxUnavailable",
			"persistence.storageClass", "persistence.size", "image.repository", "console.image.repository", "defaultBuckets"},
		[]string{"mode", "statefulset.replicaCount", "statefulset.drivesPerNode", "statefulset.zones", "persistence.storageClass"})
}

func TestHALonghornHelmKeysVerified(t *testing.T) {
	c := &config.Config{Profile: config.ProfileHA, LonghornBackupTarget: "s3://bucket@us-east-1/longhorn", LonghornBackupSecret: "longhorn-s3"}
	values, err := renderLonghornValues(c, 3)
	if err != nil {
		t.Fatal(err)
	}
	checkVerifiedKeys(t, "longhorn", yamlKeyPaths(values),
		[]string{"persistence.defaultClass", "persistence.defaultClassReplicaCount", "persistence.defaultFsType", "persistence.reclaimPolicy",
			"defaultSettings.defaultReplicaCount", "defaultSettings.replicaAutoBalance", "defaultSettings.nodeDownPodDeletionPolicy",
			"defaultSettings.upgradeChecker", "defaultSettings.allowCollectingLonghornUsageMetrics",
			"defaultSettings.storageMinimalAvailablePercentage", "defaultSettings.storageOverProvisioningPercentage", "csi.attacherReplicaCount", "csi.provisionerReplicaCount",
			"csi.resizerReplicaCount", "csi.snapshotterReplicaCount", "longhornUI.replicas", "service.ui.type", "ingress.enabled",
			"longhornManager.resources", "preUpgradeChecker.jobEnabled", "metrics.serviceMonitor.enabled",
			"defaultBackupStore.backupTarget", "defaultBackupStore.backupTargetCredentialSecret"},
		[]string{"persistence.defaultClass", "persistence.defaultClassReplicaCount", "defaultSettings.defaultReplicaCount",
			"defaultSettings.replicaAutoBalance", "defaultSettings.nodeDownPodDeletionPolicy",
			"defaultBackupStore.backupTarget", "defaultBackupStore.backupTargetCredentialSecret"})
}

func TestHACloudNativePGHelmKeysVerified(t *testing.T) {
	checkVerifiedKeys(t, "cloudnative-pg", yamlKeyPaths(readManifest("cnpg-values.yaml")),
		[]string{"crds.create", "config.clusterWide", "monitoring.podMonitorEnabled", "resources"},
		[]string{"crds.create", "config.clusterWide", "monitoring.podMonitorEnabled"})
}

// setArgKeys extracts the keys of `--set key=value` arguments.
func setArgKeys(args []string) []string {
	var keys []string
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--set" {
			if k, _, ok := strings.Cut(args[i+1], "="); ok {
				keys = append(keys, k)
			}
		}
	}
	return keys
}
