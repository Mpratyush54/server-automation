package components

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/versions"
)

func TestTelemetryProfiles(t *testing.T) {
	for _, profile := range []string{"", "minimal", "standard", "full", "ha"} {
		for _, monitoring := range []bool{false, true} {
			c := &config.Config{Profile: profile, InstallMonitoring: monitoring}
			want := profile == "full" && monitoring
			if FullTelemetry(c) != want {
				t.Fatalf("profile=%q monitoring=%v", profile, monitoring)
			}
			if !want {
				if err := InstallTelemetry(c); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
}

func TestTelemetryRetentionAndSampling(t *testing.T) {
	c := &config.Config{}
	if n, err := telemetryRetention(c); n != 30 || err != nil {
		t.Fatalf("default retention %d %v", n, err)
	}
	if n, err := telemetrySampling(c); n != 100 || err != nil {
		t.Fatalf("default sampling %v %v", n, err)
	}
	for _, v := range []string{"0", "366", "1h", "30\nINJECT=true"} {
		c.TelemetryRetentionDays = v
		if _, err := telemetryRetention(c); err == nil {
			t.Fatalf("accepted retention %q", v)
		}
	}
	for _, v := range []string{"-1", "101", "NaN", "+Inf", "garbage"} {
		c.TelemetrySamplingPercentage = v
		if _, err := telemetrySampling(c); err == nil {
			t.Fatalf("accepted sampling %q", v)
		}
	}
	c.TelemetrySamplingPercentage = "12.5"
	if n, err := telemetrySampling(c); n != 12.5 || err != nil {
		t.Fatal(n, err)
	}
}

func TestTelemetryValues(t *testing.T) {
	for _, name := range []string{"loki", "tempo", "pyroscope", "alloy", "prometheus-blackbox-exporter"} {
		v := telemetryValues(name, 7, 100)
		if v == "" || strings.Contains(v, "RETENTION_HOURS") || strings.Contains(v, "SAMPLING_PERCENTAGE") {
			t.Fatalf("unrendered %s", name)
		}
		if !strings.Contains(v, "requests:") || !strings.Contains(v, "limits:") {
			t.Fatalf("unbounded %s", name)
		}
		if name == "loki" || name == "tempo" || name == "pyroscope" {
			for _, want := range []string{"168h", "telemetry-" + name + "-s3", "${S3_SECRET_KEY}", "minio.storage.svc"} {
				if !strings.Contains(v, want) {
					t.Fatalf("%s missing %s", name, want)
				}
			}
		}
		c := versions.Get(name)
		if c.Version == "" || !strings.Contains(c.MirrorPullArgs(), c.Version) {
			t.Fatal("chart missing from offline inventory", name)
		}
	}
	tempo := telemetryValues("tempo", 30, 100)
	for _, want := range []string{"service-graphs", "span-metrics", "memBallastSizeMbs: 0", "remoteWriteUrl:"} {
		if !strings.Contains(tempo, want) {
			t.Fatal("Tempo missing", want)
		}
	}
}

func TestAlloyPipelineAndStandaloneConfigStayInSync(t *testing.T) {
	b, err := os.ReadFile("../manifests/data/telemetry.alloy")
	if err != nil {
		t.Fatal(err)
	}
	// Compare line content only: a Windows checkout has CRLF files.
	v := strings.ReplaceAll(telemetryValues("alloy", 30, 100), "", "")
	standalone := strings.ReplaceAll(strings.ReplaceAll(string(b), "", ""), "SAMPLING_PERCENTAGE", "100")
	for _, line := range strings.Split(strings.TrimSpace(standalone), "\n") {
		if !strings.Contains(v, "      "+line+"\n") {
			t.Fatalf("config drift: %s", line)
		}
	}
	for _, want := range []string{"include_metadata = true", "metadata.x-platform-project-id", "metadata.x-platform-environment", "context = \"datapoint\"", "platform.io/project", "platform.io/env", "sampling_percentage = 100", "send_batch_max_size = 1024", "encoding.from_json(local.file.origins.content)"} {
		if !strings.Contains(v, want) {
			t.Fatal("Alloy missing", want)
		}
	}
	if strings.Contains(v, "allowed_origins = [\"*\"]") {
		t.Fatal("wildcard browser origins")
	}
	if strings.Index(v, "from_context =") > strings.Index(v, "otelcol.processor.batch \"ingest\"") {
		t.Fatal("identity processing must precede batching")
	}
}

func TestTelemetryIngestContract(t *testing.T) {
	v := readManifest("telemetry-ingress.yaml")
	for _, want := range []string{"otel.{{DOMAIN}}", "/v1/traces", "/v1/logs", "/v1/metrics", "/collect", "/pyroscope", "/api/telemetry/ingest-auth", "auth-response-headers: X-Platform-Project-Id,X-Platform-Environment", "$http_authorization|$http_origin|$request_uri", "200 60s", "limit-rps:", "secretName: telemetry-tls"} {
		if !strings.Contains(v, want) {
			t.Fatal("ingress missing", want)
		}
	}
	policy := readManifest("telemetry-policy.yaml")
	if strings.Contains(policy, "namespace.name: default") || !strings.Contains(policy, "podSelector:") {
		t.Fatal("collector must not trust arbitrary internal clients")
	}
	data := readManifest("telemetry-dashboard.yaml")
	start := strings.Index(data, "    {")
	if start < 0 || !json.Valid([]byte(strings.TrimSpace(data[start:]))) {
		t.Fatal("invalid provisioned dashboard JSON")
	}
}

func TestTelemetryIAMShellQuotingAndFailure(t *testing.T) {
	for _, bucket := range []string{"loki", "tempo", "pyroscope"} {
		t.Run(bucket, func(t *testing.T) {
			dir := filepath.ToSlash(t.TempDir())
			secret := "test ' dollar $() ; spaces"
			prefix := "TMPDIR=" + shellQuote(dir) + "\nROOT_USER=root\nROOT_PASSWORD=" + shellQuote(secret) + "\nS3_ACCESS_KEY=telemetry-" + bucket + "\nS3_SECRET_KEY=" + shellQuote(secret) + "\nBUCKET=" + shellQuote(bucket) + "\n" + telemetryFakeMC
			if out, err := runJobShell(t, prefix+telemetryBucketScript(bucket)); err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if out, err := runJobShell(t, prefix+"FAIL_IAM=1\n"+telemetryBucketScript(bucket)); err == nil {
				t.Fatalf("IAM error ignored: %s", out)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 0 {
				t.Fatalf("private IAM scratch survived: %v %v", entries, err)
			}
		})
	}
}

const telemetryFakeMC = `mc() {
 case "$1 $2" in
  'alias set') [[ "$5" == "$ROOT_USER" && "$6" == "$ROOT_PASSWORD" ]] || return 91;;
  'mb --ignore-existing') [[ "$3" == "local/$BUCKET" ]] || return 92;;
  'admin user') [[ "${FAIL_IAM:-0}" != 1 ]] || return 20
    [[ "$5" == "$S3_ACCESS_KEY" && "$6" == "$S3_SECRET_KEY" ]] || return 93;;
  'admin policy')
    if [[ "$3" == create ]]; then
      [[ "$5" == "telemetry-$BUCKET" ]] || return 94
      grep -q "arn:aws:s3:::$BUCKET" "$6" || return 95
      ! grep -q 's3:\*' "$6" || return 96
    else
      [[ "$3" == attach && "$5" == "telemetry-$BUCKET" && "$7" == "$S3_ACCESS_KEY" ]] || return 97
    fi;;
  *) return 98;;
 esac
}
`

// Opt-in integration gates use real parsers. They never contact a cluster or
// write host paths; they do need the pinned chart archives and Alloy binary.
func TestTelemetryHelmRender(t *testing.T) {
	if os.Getenv("PLATFORMCTL_VALIDATE_CHARTS") != "1" {
		t.Skip("set PLATFORMCTL_VALIDATE_CHARTS=1 with Helm and chart access")
	}
	for _, name := range []string{"loki", "tempo", "pyroscope", "alloy", "prometheus-blackbox-exporter"} {
		p := filepath.Join(t.TempDir(), "values.yaml")
		if err := os.WriteFile(p, []byte(telemetryValues(name, 30, 100)), 0600); err != nil {
			t.Fatal(err)
		}
		c := versions.Get(name)
		args := []string{"template", name, c.Chart, "--repo", c.RepoURL, "--version", c.Version, "--namespace", "monitoring", "--kube-version", "1.31.0", "--skip-tests", "-f", p}
		if out, err := exec.Command("helm", args...).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", name, err, out)
		}
	}
}

func TestAlloyValidate(t *testing.T) {
	bin := os.Getenv("ALLOY_BIN")
	if bin == "" {
		t.Skip("set ALLOY_BIN to the pinned Alloy binary")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "origins.json"), []byte("[]"), 0600); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("../manifests/data/telemetry.alloy")
	if err != nil {
		t.Fatal(err)
	}
	v := strings.NewReplacer("SAMPLING_PERCENTAGE", "100", "/etc/telemetry-origins/origins.json", filepath.ToSlash(filepath.Join(dir, "origins.json"))).Replace(string(b))
	p := filepath.Join(dir, "config.alloy")
	if err := os.WriteFile(p, []byte(v), 0600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(bin, "validate", "--stability.level=public-preview", p).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
}

func TestInstallTelemetryWithFakeTools(t *testing.T) {
	calls := fakeTools(t)
	password := "literal ' password $() , false=true"
	c := &config.Config{Profile: config.ProfileFull, InstallMonitoring: true, Domain: "example.test", MinioAccessKey: "root-test", MinioSecretKey: password, GrafanaPassword: password}
	if err := InstallTelemetry(c); err != nil {
		t.Fatal(err)
	}
	if !state.IsDone("telemetry") {
		t.Fatal("successful install not recorded")
	}
	buckets, jobs, waits := map[string]bool{}, 0, 0
	lastChart, marker := -1, -1
	for i, call := range calls() {
		if strings.Contains(strings.Join(call.Args, " "), password) {
			t.Fatal("password leaked into command arguments")
		}
		if call.Tool == "bash" && strings.Contains(strings.Join(call.Args, " "), "helm upgrade --install") {
			lastChart = i
		}
		if call.Tool == "kubectl" && strings.Contains(strings.Join(call.Args, " "), "--for=condition=complete") {
			waits++
		}
		if call.Input == "" {
			continue
		}
		var obj map[string]any
		if err := json.Unmarshal([]byte(call.Input), &obj); err != nil {
			t.Fatal(err)
		}
		metadata := obj["metadata"].(map[string]any)
		name := metadata["name"].(string)
		if obj["kind"] == "Secret" && strings.HasSuffix(name, "-s3") {
			data := obj["stringData"].(map[string]any)
			if data["S3_SECRET_KEY"] == password || len(data["S3_SECRET_KEY"].(string)) != 64 {
				t.Fatal("invalid scoped secret")
			}
			buckets[name] = true
		}
		if obj["kind"] == "Job" {
			jobs++
			if strings.Contains(call.Input, password) {
				t.Fatal("root credential embedded in Job")
			}
			if !strings.Contains(call.Input, "telemetry-bootstrap") || !strings.Contains(call.Input, "resources") {
				t.Fatal("job missing secret ref or resources")
			}
		}
		if name == "telemetry-backend" {
			marker = i
		}
	}
	if len(buckets) != 3 || jobs != 3 || waits != 3 {
		t.Fatalf("buckets=%d jobs=%d waits=%d", len(buckets), jobs, waits)
	}
	if marker < lastChart || marker < 0 {
		t.Fatal("enabled marker published before backends installed")
	}
}

func TestFullProfileMinIOBudget(t *testing.T) {
	if _, ok := minioInstallValues(&config.Config{})["resources"]; ok {
		t.Fatal("changed legacy MinIO budget")
	}
	values := minioInstallValues(&config.Config{Profile: config.ProfileFull, InstallMonitoring: true})
	if _, ok := values["resources"]; !ok {
		t.Fatal("full-profile MinIO unbounded")
	}
}

// #49 turns the /api/sdk/config telemetry block on from PLATFORM_OBSERVABILITY.
func TestObservabilityFlagFollowsFullTelemetry(t *testing.T) {
	full := &config.Config{Profile: config.ProfileFull, InstallMonitoring: true}
	std := &config.Config{Profile: config.ProfileStandard, InstallMonitoring: true}
	if observabilityFlag(full) != "enabled" || observabilityFlag(std) != "" {
		t.Fatalf("full=%q standard=%q", observabilityFlag(full), observabilityFlag(std))
	}
}
