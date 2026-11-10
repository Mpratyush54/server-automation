package components

import (
	"os"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

// A Windows checkout may have CRLF manifests.
func normalizeEOL(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }

// Profiles must reach the collector only through the profile-ingest proxy,
// which sets project/environment/service labels from the auth headers.
func TestProfileIngestRoutesThroughLabelProxy(t *testing.T) {
	ing := normalizeEOL(readManifest("telemetry-ingress.yaml"))
	i := strings.Index(ing, "/pyroscope(/|$)(.*)")
	if i < 0 {
		t.Fatal("profiles route missing")
	}
	route := ing[i:]
	if !strings.Contains(route, "name: profile-ingest") || !strings.Contains(route, "port: {number: 8080}") || strings.Contains(route, "9999") {
		t.Fatalf("/pyroscope must route to profile-ingest:8080:\n%s", route)
	}
	profiles := ing[strings.Index(ing, "name: telemetry-profiles"):]
	for _, want := range []string{"auth-url: http://platform-api.platform.svc.cluster.local:3000/api/telemetry/ingest-auth", "auth-response-headers: X-Platform-Project-Id,X-Platform-Environment", "rewrite-target: /$2"} {
		if !strings.Contains(profiles, want) {
			t.Fatal("profiles ingress missing", want)
		}
	}

	policy := normalizeEOL(readManifest("telemetry-policy.yaml"))
	collector := policy[:strings.Index(policy, "\n---")]
	// The only rule exposing 9999 to the ingress controller must be gone; the
	// receiver accepts the proxy (and the trusted platform API) only.
	for _, rule := range strings.Split(collector, "    - from:")[1:] {
		if strings.Contains(rule, "port: 9999") && strings.Contains(rule, "ingress-nginx") {
			t.Fatalf("ingress controller can bypass the profile proxy:\n%s", rule)
		}
	}
	if !strings.Contains(collector, "matchLabels: {app.kubernetes.io/name: profile-ingest}\n      ports:\n        - {port: 9999, protocol: TCP}") {
		t.Fatal("profile proxy cannot reach the receiver")
	}
}

// Trace-to-profile links must match the proxy's labels, not the prefixed service_name.
func TestTraceToProfileLinkUsesProxyLabels(t *testing.T) {
	g := normalizeEOL(readManifest("telemetry-grafana-values.yaml"))
	for _, want := range []string{"{key: platform.project_id, value: platform_project_id}", "{key: service.name, value: platform_service}"} {
		if !strings.Contains(g, want) {
			t.Fatal("tracesToProfiles missing", want)
		}
	}
	if strings.Contains(g, "tags: [service.name]") {
		t.Fatal("tracesToProfiles still matches service_name")
	}
}

func TestProfileIngestManifestIsRestrictedAndBounded(t *testing.T) {
	m := normalizeEOL(readManifest("telemetry-profile-ingest.yaml"))
	for _, want := range []string{
		"kind: Deployment", "kind: Service", "kind: NetworkPolicy",
		"image: {{PROFILE_INGEST_IMAGE}}",
		"runAsNonRoot: true", "seccompProfile: {type: RuntimeDefault}", "allowPrivilegeEscalation: false",
		"readOnlyRootFilesystem: true", "capabilities: {drop: [ALL]}", "automountServiceAccountToken: false",
		"requests: {cpu: 10m, memory: 16Mi}", "limits: {cpu: 200m, memory: 64Mi}",
		"value: \"http://alloy.monitoring.svc:9999\"",
		"matchLabels: {kubernetes.io/metadata.name: ingress-nginx}",
	} {
		if !strings.Contains(m, want) {
			t.Fatal("profile-ingest manifest missing", want)
		}
	}
	np := m[strings.Index(m, "kind: NetworkPolicy"):]
	if strings.Count(np, "- from:") != 1 || !strings.Contains(np[:strings.Index(np, "- ports:")], "port: 8080") {
		t.Fatalf("proxy port must accept the ingress controller only:\n%s", np)
	}
}

func TestProfileIngestManifestRendering(t *testing.T) {
	c := &config.Config{Domain: "example.test", ImageRegistry: "ghcr.io/example", ImageTag: "1.2.3"}
	img, err := ProfileIngestImage(c)
	if err != nil || img != "ghcr.io/example/platform-profile-ingest:1.2.3" {
		t.Fatal(img, err)
	}
	p, err := telemetryManifest("telemetry-profile-ingest.yaml", c, img)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(p)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "image: ghcr.io/example/platform-profile-ingest:1.2.3") || strings.Contains(string(b), "{{") {
		t.Fatalf("unrendered proxy manifest:\n%s", b)
	}
	if img, err := ProfileIngestImage(&config.Config{}); err != nil || !strings.HasPrefix(img, "ghcr.io/mpratyush54/platform-profile-ingest:") {
		t.Fatal("default image", img, err)
	}
	for _, bad := range []config.Config{{ImageRegistry: "ghcr.io/x", ImageTag: "1\nimage: evil"}, {ImageRegistry: "ghcr.io/x y", ImageTag: "1"}, {ImageRegistry: "ghcr.io/x", ImageTag: "-rm"}} {
		if _, err := ProfileIngestImage(&bad); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
}

func TestInstallTelemetryDeploysProfileProxyBeforeIngress(t *testing.T) {
	calls := fakeTools(t)
	c := &config.Config{Profile: config.ProfileFull, InstallMonitoring: true, Domain: "example.test", MinioAccessKey: "root-test", MinioSecretKey: "s", GrafanaPassword: "g", ImageRegistry: "ghcr.io/example", ImageTag: "1.2.3"}
	if err := InstallTelemetry(c); err != nil {
		t.Fatal(err)
	}
	rollout, applies := -1, 0
	for i, call := range calls() {
		args := strings.Join(call.Args, " ")
		if call.Tool == "kubectl" && strings.Contains(args, "rollout status deployment/profile-ingest") {
			rollout = i
			if applies != 2 { // telemetry-policy.yaml, telemetry-profile-ingest.yaml
				t.Fatalf("proxy readiness checked after %d file applies", applies)
			}
		}
		if call.Tool == "kubectl" && strings.HasPrefix(args, "apply -f ") && args != "apply -f -" {
			applies++
		}
	}
	if rollout < 0 || applies != 7 { // policy, profile-ingest, ingress, rules, dashboard, database monitor, alerting RBAC
		t.Fatalf("rollout=%d file applies=%d", rollout, applies)
	}
}
