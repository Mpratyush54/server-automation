package components

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

// FullTelemetry deliberately does not interpret an empty profile as full:
// old saved installations must explicitly opt in to the new storage layout.
// observabilityFlag is PLATFORM_OBSERVABILITY for the API: "enabled" when the
// collector at otel.<DOMAIN> is installed, "" (disabled) otherwise.
func observabilityFlag(c *config.Config) string {
	if FullTelemetry(c) {
		return "enabled"
	}
	return ""
}

func FullTelemetry(c *config.Config) bool {
	return c.Profile == config.ProfileFull && c.InstallMonitoring
}

func telemetryRetention(c *config.Config) (int, error) {
	v := c.TelemetryRetentionDays
	if v == "" {
		return 30, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 1 || n > 365 {
		return 0, fmt.Errorf("TELEMETRY_RETENTION_DAYS must be 1..365")
	}
	return n, nil
}

func telemetryValues(name string, days int, sampling float64) string {
	return strings.NewReplacer("RETENTION_HOURS", strconv.Itoa(days*24)+"h", "SAMPLING_PERCENTAGE", strconv.FormatFloat(sampling, 'f', -1, 64)).Replace(readManifest("telemetry-" + name + "-values.yaml"))
}

func telemetrySampling(c *config.Config) (float64, error) {
	v := c.TelemetrySamplingPercentage
	if v == "" {
		return 100, nil
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil || !(n >= 0 && n <= 100) {
		return 0, fmt.Errorf("TELEMETRY_SAMPLING_PERCENTAGE must be 0..100")
	}
	return n, nil
}

// InstallTelemetry runs after platform (MinIO OIDC discovery), monitoring
// coordination, and routing (the ingress admission webhook and TLS issuer).
// It installs Prometheus CRDs before installing the full backend charts.
// Reconcile on reruns, including upgrades from an already completed monitoring step.
func InstallTelemetry(c *config.Config) error {
	if !FullTelemetry(c) {
		return nil
	}
	uid := c.TelemetryLokiDatasourceUID
	if uid == "" {
		uid = "loki"
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9_-]{1,40}$`).MatchString(uid) {
		return fmt.Errorf("TELEMETRY_LOKI_DATASOURCE_UID must be a Grafana UID (1..40 letters, digits, underscores or hyphens)")
	}
	sampling, err := telemetrySampling(c)
	if err != nil {
		return err
	}
	days, err := telemetryRetention(c)
	if err != nil {
		return err
	}
	proxyImage, err := ProfileIngestImage(c)
	if err != nil {
		return err
	}
	// Never replace a local Loki release implicitly. Its PVC may contain the
	// only copy of historic logs; see the explicit migration procedure.
	old, err := shell.Output("helm", "list", "-n", "monitoring", "-o", "json", "--filter", "^loki$")
	if err != nil {
		return err
	}
	if strings.Contains(old, "loki-stack-") {
		return fmt.Errorf("legacy loki-stack detected: back up and follow docs/operations/telemetry.md before installing full telemetry")
	}
	if err := telemetryStorage(c); err != nil {
		return err
	}
	// Preserve the API-owned origins ConfigMap across installer reruns.
	existing, err := shell.Output("kubectl", "-n", "monitoring", "get", "configmap", "telemetry-origins", "--ignore-not-found", "-o", "name")
	if err != nil {
		return err
	}
	if existing == "" {
		if err := applyTelemetryJSON(map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "telemetry-origins", "namespace": "monitoring"}, "data": map[string]string{"origins.json": "[]"}}); err != nil {
			return err
		}
	}
	// Upgrade the existing Grafana/Prometheus release rather than installing a
	// second UI or changing the Loki service name used by the platform API.
	base, err := temporaryManifest("grafana-values.yaml", c)
	if err != nil {
		return err
	}
	defer os.Remove(base)
	full, err := temporaryManifest("telemetry-grafana-values.yaml", c)
	if err != nil {
		return err
	}
	defer os.Remove(full)
	fullData, err := os.ReadFile(full)
	if err != nil {
		return err
	}
	fullData = []byte(strings.NewReplacer("uid: loki\n", "uid: "+uid+"\n", "datasourceUid: loki\n", "datasourceUid: "+uid+"\n").Replace(string(fullData)))
	if err := os.WriteFile(full, fullData, 0600); err != nil {
		return err
	}

	if err := helmValues("kube-prometheus", "kube-prometheus-stack", "monitoring", map[string]any{"grafana": map[string]string{"adminPassword": c.GrafanaPassword}}, "-f", base, "-f", full, "--set", "grafana.assertNoLeakedSecrets=false", "--set", fmt.Sprintf("prometheus.prometheusSpec.retention=%dd", days), "--wait", "--timeout", "10m"); err != nil {
		return err
	}
	// Enforce the collector trust boundary before its first pod is exposed.
	policy, err := temporaryManifest("telemetry-policy.yaml", c)
	if err != nil {
		return err
	}
	err = shell.Run("kubectl", "apply", "-f", policy)
	os.Remove(policy)
	if err != nil {
		return err
	}
	for _, name := range []string{"loki", "tempo", "pyroscope", "prometheus-blackbox-exporter", "alloy"} {
		f, err := os.CreateTemp("", "telemetry-*-values.yaml")
		if err != nil {
			return err
		}
		path := f.Name()
		_, err = f.WriteString(telemetryValues(name, days, sampling))
		closeErr := f.Close()
		if err == nil {
			err = closeErr
		}
		if err == nil {
			err = shell.RunBash(fmt.Sprintf("set -euo pipefail\nhelm upgrade --install %s %s -n monitoring --create-namespace -f %s --wait --timeout 10m", name, chart(name), shellQuote(path)))
		}
		os.Remove(path)
		if err != nil {
			return fmt.Errorf("telemetry %s: %w", name, err)
		}
	}
	// The profile proxy is applied (and ready) before the Ingress routes to it.
	for _, name := range []string{"telemetry-profile-ingest.yaml", "telemetry-ingress.yaml", "telemetry-rules.yaml", "telemetry-dashboard.yaml", "database-monitoring.yaml", alertingRBACManifest} {
		p, err := telemetryManifest(name, c, proxyImage)
		if err != nil {
			return err
		}
		err = shell.Run("kubectl", "apply", "-f", p)
		os.Remove(p)
		if err != nil {
			return err
		}
		if name == "telemetry-profile-ingest.yaml" {
			if err := shell.Run("kubectl", "-n", "monitoring", "rollout", "status", "deployment/profile-ingest", "--timeout=180s"); err != nil {
				return fmt.Errorf("telemetry profile-ingest: %w", err)
			}
		}
	}
	if err := publishTelemetryBackend(c, sampling); err != nil {
		return err
	}
	return state.MarkDone("telemetry")
}

func applyTelemetryJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, string(b))
	return err
}

func telemetryStorage(c *config.Config) error {
	// Root credentials exist only for the duration of the IAM bootstrap jobs.
	if err := applyTelemetryJSON(map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]string{"name": "telemetry-bootstrap", "namespace": "monitoring"}, "stringData": map[string]string{"ROOT_USER": c.MinioAccessKey, "ROOT_PASSWORD": c.MinioSecretKey}}); err != nil {
		return err
	}
	defer shell.RunSilent("kubectl", "-n", "monitoring", "delete", "secret", "telemetry-bootstrap", "--ignore-not-found")
	// loki/tempo/pyroscope: backend object storage. replays: #40 session chunks + #47 GDPR delete prefix.
	for _, backend := range []string{"loki", "tempo", "pyroscope", "replays"} {
		name := "telemetry-" + backend + "-s3"
		existing, err := shell.Output("kubectl", "-n", "monitoring", "get", "secret", name, "--ignore-not-found", "-o", "name")
		if err != nil {
			return err
		}
		if existing == "" {
			key := make([]byte, 32)
			if _, err := rand.Read(key); err != nil {
				return err
			}
			if err := applyTelemetryJSON(map[string]any{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]string{"name": name, "namespace": "monitoring"}, "stringData": map[string]string{"S3_ACCESS_KEY": "telemetry-" + backend, "S3_SECRET_KEY": hex.EncodeToString(key)}}); err != nil {
				return err
			}
		}
		job := "telemetry-storage-" + backend
		if err := shell.Run("kubectl", "-n", "monitoring", "delete", "job", job, "--ignore-not-found", "--wait=true"); err != nil {
			return err
		}
		container := map[string]any{"name": "mc", "image": telemetryMCImage, "command": []string{"/bin/sh", "-ec", telemetryBucketScript(backend)}, "envFrom": []any{map[string]any{"secretRef": map[string]string{"name": "telemetry-bootstrap"}}, map[string]any{"secretRef": map[string]string{"name": name}}}, "resources": map[string]any{"requests": map[string]string{"cpu": "25m", "memory": "64Mi"}, "limits": map[string]string{"cpu": "200m", "memory": "256Mi"}}}
		if err := applyTelemetryJSON(map[string]any{"apiVersion": "batch/v1", "kind": "Job", "metadata": map[string]string{"name": job, "namespace": "monitoring"}, "spec": map[string]any{"backoffLimit": 3, "activeDeadlineSeconds": 900, "ttlSecondsAfterFinished": 3600, "template": map[string]any{"spec": map[string]any{"restartPolicy": "Never", "containers": []any{container}}}}}); err != nil {
			return err
		}
		// Wait for Complete OR Failed: `kubectl wait --for=condition=complete` would
		// sit out the whole timeout on a failed Job. On failure print the pod log.
		if err := shell.RunBash(telemetryJobWaitScript(job, 930)); err != nil {
			return fmt.Errorf("MinIO IAM job %s failed: %w", job, err)
		}
	}
	return nil
}

// telemetryJobWaitScript waits until the Job completes (exit 0) or fails (exit 1,
// printing the newest pod's log), or the timeout passes.
func telemetryJobWaitScript(job string, timeoutSec int) string {
	return fmt.Sprintf(`set -uo pipefail
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
job=%s
for _ in $(seq 1 %d); do
  conds="$(kubectl -n monitoring get job "$job" -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}' 2>/dev/null || true)"
  case " $conds " in
    *" Complete=True "*) exit 0 ;;
    *" Failed=True "*)
      pod="$(kubectl -n monitoring get pods -l job-name="$job" --sort-by=.metadata.creationTimestamp -o name 2>/dev/null | tail -1)"
      echo "job $job failed; last pod log:" >&2
      [ -n "$pod" ] && kubectl -n monitoring logs "$pod" --tail=30 >&2 || true
      exit 1 ;;
  esac
  sleep 1
done
echo "job $job did not finish within %ds" >&2
exit 1
`, shellQuote(job), timeoutSec, timeoutSec)
}

// The MinIO server image already used by the minio chart (and in the platform
// stack) ships the mc client; upstream quay.io/minio/mc tags are not reliably
// available, so no separate client image is pulled.
const telemetryMCImage = "docker.io/bitnamilegacy/minio:2025.7.23-debian-12-r3"

func telemetryBucketScript(bucket string) string {
	// bucket is an internal constant, never operator input. Commands never print
	// credentials; mc's private config is on the ephemeral job filesystem.
	// Replays get a 365-day lifecycle backstop; per-project retention (default 7 days) is
	// applied by the API replay-retention job (#47 / #40).
	lifecycle := ""
	if bucket == "replays" {
		lifecycle = `
cat >"$work/lifecycle.json" <<'LIFECYCLE'
{"Rules":[{"ID":"replays-max-365d","Status":"Enabled","Filter":{"Prefix":"replays/"},"Expiration":{"Days":365}}]}
LIFECYCLE
mc ilm import local/replays <"$work/lifecycle.json" >/dev/null || mc ilm rule add --expire-days 365 local/replays >/dev/null
`
	}
	return fmt.Sprintf(`set -eu
umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/telemetry-iam.XXXXXX")
trap 'rm -rf "$work"' EXIT
export MC_CONFIG_DIR="$work/mc"
mc alias set local http://minio.storage.svc.cluster.local:9000 "$ROOT_USER" "$ROOT_PASSWORD" >/dev/null
# MinIO IAM answers "Server not initialized" until its OpenID issuer (platform API) is reachable.
waited=0
until mc admin policy list local >/dev/null 2>&1; do
  [ "$waited" -ge 600 ] && { echo "MinIO admin API not ready after 600s" >&2; exit 1; }
  sleep 5; waited=$((waited + 5))
done
mc mb --ignore-existing local/%[1]s
cat >"$work/policy.json" <<'POLICY'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation","s3:ListBucketMultipartUploads"],"Resource":["arn:aws:s3:::%[1]s"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::%[1]s/*"]}]}
POLICY
mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
mc admin policy create local telemetry-%[1]s "$work/policy.json"
# attach fails when already attached (re-run): accept an existing mapping.
if ! mc admin policy attach local telemetry-%[1]s --user "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user info local "$S3_ACCESS_KEY" 2>/dev/null | grep -q "telemetry-%[1]s" || { echo "attach policy telemetry-%[1]s failed" >&2; exit 1; }
fi
%[2]s`, bucket, lifecycle)
}

// Existing MinIO chart defaults are too large for the 8 GB full-profile target.
// Standard/minimal values retain their previous behavior.
func minioInstallValues(c *config.Config) map[string]any {
	values := map[string]any{"auth": map[string]string{"rootUser": c.MinioAccessKey, "rootPassword": c.MinioSecretKey}}
	if FullTelemetry(c) {
		values["resources"] = map[string]any{"requests": map[string]string{"cpu": "100m", "memory": "128Mi"}, "limits": map[string]string{"cpu": "1", "memory": "384Mi"}}
		values["console"] = map[string]any{"resources": map[string]any{"requests": map[string]string{"cpu": "25m", "memory": "32Mi"}, "limits": map[string]string{"cpu": "200m", "memory": "128Mi"}}}
	}
	return values
}

// #49 can discover healthy collector endpoints without enabling SDKs merely
// because an operator selected the profile. Published only after Helm readiness.
func publishTelemetryBackend(c *config.Config, sampling float64) error {
	endpoint := "https://otel." + c.Domain
	return applyTelemetryJSON(map[string]any{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]string{"name": "telemetry-backend", "namespace": "monitoring"}, "data": map[string]string{"enabled": "true", "otlpEndpoint": endpoint, "faroEndpoint": endpoint + "/collect", "profilesEndpoint": endpoint + "/pyroscope", "samplingRatio": strconv.FormatFloat(sampling/100, 'f', -1, 64)}})
}

// telemetryManifest writes a private temporary copy of a telemetry manifest
// with installer substitutions applied; the caller removes it.
func telemetryManifest(name string, c *config.Config, proxyImage string) (string, error) {
	p, err := temporaryManifest(name, c)
	if err != nil {
		return "", err
	}
	var r *strings.Replacer
	switch name {
	case "telemetry-profile-ingest.yaml":
		r = strings.NewReplacer("{{PROFILE_INGEST_IMAGE}}", proxyImage)
	case "telemetry-ingress.yaml":
		r = strings.NewReplacer("letsencrypt-prod", ActiveIssuer())
	default:
		return p, nil
	}
	b, err := os.ReadFile(p)
	if err == nil {
		err = os.WriteFile(p, []byte(r.Replace(string(b))), 0600)
	}
	if err != nil {
		os.Remove(p)
		return "", err
	}
	return p, nil
}

var imageRefRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._/:-]*$`)
var imageTagRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

// ProfileIngestImage is the profile ingest proxy image of this release
// (built with platform-api/portal by docker-build.yml; tag-dependent like them).
func ProfileIngestImage(c *config.Config) (string, error) {
	registry, tag := strings.TrimRight(strings.TrimSpace(c.ImageRegistry), "/"), strings.TrimSpace(c.ImageTag)
	if registry == "" {
		registry = "ghcr.io/mpratyush54"
	}
	if tag == "" {
		tag = config.DefaultImageTag
	}
	if !imageRefRe.MatchString(registry) || !imageTagRe.MatchString(tag) {
		return "", fmt.Errorf("invalid PLATFORM_IMAGE_REGISTRY/PLATFORM_IMAGE_TAG for the profile ingest image")
	}
	return registry + "/platform-profile-ingest:" + tag, nil
}
