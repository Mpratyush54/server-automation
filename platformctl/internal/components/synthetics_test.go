package components

import (
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/manifests"
)

// syntheticsDoc returns the manifest document with this kind and name.
func syntheticsDoc(t *testing.T, kind, name string) string {
	t.Helper()
	b, err := manifests.Read("synthetics.yaml")
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n---") {
		if strings.Contains(part, "\nkind: "+kind+"\n") && strings.Contains(part, "\n  name: "+name+"\n") {
			return part
		}
	}
	t.Fatalf("%s %s missing", kind, name)
	return ""
}

func TestSyntheticsSkippedOutsideFullProfile(t *testing.T) {
	for _, profile := range []string{"", "minimal", "standard"} {
		if err := InstallSynthetics(&config.Config{Profile: profile, InstallMonitoring: true}); err != nil {
			t.Fatalf("profile %q: %v", profile, err)
		}
	}
	if err := InstallSynthetics(&config.Config{Profile: "full", InstallMonitoring: false}); err != nil {
		t.Fatal(err)
	}
}

func TestSyntheticsNamespaceIsRestrictedAndBounded(t *testing.T) {
	ns := syntheticsDoc(t, "Namespace", "synthetics")
	if !strings.Contains(ns, "pod-security.kubernetes.io/enforce: restricted") {
		t.Fatal("synthetics namespace must enforce Pod Security restricted")
	}
	quota := syntheticsDoc(t, "ResourceQuota", "synthetics-browser")
	for _, want := range []string{`pods: "2"`, "limits.cpu:", "limits.memory:", "requests.memory:"} {
		if !strings.Contains(quota, want) {
			t.Fatalf("quota missing %s", want)
		}
	}
	lr := syntheticsDoc(t, "LimitRange", "synthetics-defaults")
	if !strings.Contains(lr, "max: {cpu: \"1\", memory: 1Gi") {
		t.Fatal("limit range must cap a runner at 1 CPU / 1 GiB")
	}
}

func TestSyntheticsEgressExcludesPrivateRanges(t *testing.T) {
	for _, name := range []string{"synthetics-runner", "blackbox-exporter-egress"} {
		np := syntheticsDoc(t, "NetworkPolicy", name)
		if !strings.Contains(np, "Egress") {
			t.Fatalf("%s must restrict egress", name)
		}
		for _, cidr := range []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "127.0.0.0/8", "100.64.0.0/10"} {
			if !strings.Contains(np, cidr) {
				t.Fatalf("%s must exclude %s", name, cidr)
			}
		}
	}
	runner := syntheticsDoc(t, "NetworkPolicy", "synthetics-runner")
	if !strings.Contains(runner, "app: platform-api") || !strings.Contains(runner, "port: 3001") {
		t.Fatal("runners must reach the platform API's runner port")
	}
	if strings.Contains(runner, "port: 3000") {
		t.Fatal("runners must not reach the main API port (only the runner-only listener)")
	}
	svc := syntheticsDoc(t, "Service", "platform-api-synthetics")
	if !strings.Contains(svc, "namespace: platform") || !strings.Contains(svc, "targetPort: 3001") || !strings.Contains(svc, "selector: {app: platform-api}") {
		t.Fatalf("runner Service must expose only the API's runner port: %s", svc)
	}
	if cm := syntheticsRunnerConfigMap(&config.Config{}); cm["data"].(map[string]string)["apiUrl"] != "http://platform-api-synthetics.platform.svc:3001" {
		t.Fatalf("runner apiUrl must target the runner-only Service, got %v", cm["data"])
	}
	if !strings.Contains(runner, "ingress: []") {
		t.Fatal("runner pods accept no ingress")
	}
	if !strings.Contains(syntheticsDoc(t, "NetworkPolicy", "blackbox-exporter-egress"), "app.kubernetes.io/name: prometheus-blackbox-exporter") {
		t.Fatal("blackbox policy must select the blackbox-exporter pods")
	}
}

func TestSyntheticsRBACIsScoped(t *testing.T) {
	b, err := manifests.Read("synthetics.yaml")
	if err != nil {
		t.Fatal(err)
	}
	text := string(b)
	for _, bad := range []string{"kind: ClusterRole", "\"*\"", "pods/exec", "escalate", "verbs: [bind]", "impersonate"} {
		if strings.Contains(text, bad) {
			t.Fatalf("synthetics RBAC must not contain %s", bad)
		}
	}
	probes := syntheticsDoc(t, "Role", "platform-api-synthetic-probes")
	if !strings.Contains(probes, "namespace: monitoring") || !strings.Contains(probes, "resources: [probes]") {
		t.Fatal("probe role must be limited to probes in monitoring")
	}
	runner := syntheticsDoc(t, "Role", "platform-api-synthetics")
	if !strings.Contains(runner, "resourceNames: [synthetics-runner]") {
		t.Fatal("configmap access must be limited to synthetics-runner")
	}
	// Jobs and pods are read-only (diagnosing runs that did not report).
	for _, res := range []string{"jobs", "pods"} {
		i := strings.Index(runner, "resources: ["+res+"]")
		if i < 0 {
			t.Fatalf("role must read %s", res)
		}
		if line := strings.SplitN(runner[i:], "\n", 3)[1]; !strings.Contains(line, "verbs: [get, list]") {
			t.Fatalf("%s access must be read-only, got %q", res, line)
		}
	}
}

func TestSyntheticsRunnerConfigMap(t *testing.T) {
	c := &config.Config{ImageRegistry: "ghcr.io/example", ImageTag: "1.2.3"}
	off := syntheticsRunnerConfigMap(c)["data"].(map[string]string)
	if off["browser"] != "disabled" || off["image"] != "" {
		t.Fatalf("browser must be off by default: %v", off)
	}
	c.SyntheticsBrowser = true
	on := syntheticsRunnerConfigMap(c)["data"].(map[string]string)
	if on["browser"] != "enabled" || on["image"] != "ghcr.io/example/platform-synthetics-runner:1.2.3" {
		t.Fatalf("unexpected runner config: %v", on)
	}
}

func TestBlackboxSyntheticModules(t *testing.T) {
	v := telemetryValues("prometheus-blackbox-exporter", 30, 100)
	for _, want := range []string{"synthetic_http:", "synthetic_tls:", "body_size_limit: 1MB", "tls: true"} {
		if !strings.Contains(v, want) {
			t.Fatalf("blackbox values missing %s", want)
		}
	}
}

func TestSyntheticsRunnerReachesOnlyIngressControllerForEnvHosts(t *testing.T) {
	runner := syntheticsDoc(t, "NetworkPolicy", "synthetics-runner")
	for _, want := range []string{
		"matchLabels: {kubernetes.io/metadata.name: ingress-nginx}",
		"matchLabels: {app.kubernetes.io/component: controller}",
		"{port: 80, protocol: TCP}",
		"{port: 443, protocol: TCP}",
	} {
		if !strings.Contains(runner, want) {
			t.Fatalf("runner policy must allow the ingress controller (%s):\n%s", want, runner)
		}
	}
	// Private ranges stay excluded from the internet rule.
	if !strings.Contains(runner, "10.0.0.0/8") {
		t.Fatal("runner internet rule must still exclude 10.0.0.0/8")
	}
}

const testCA = `-----BEGIN CERTIFICATE-----
MIIBdzCCAR2gAwIBAgIQZ0n2kQ==
-----END CERTIFICATE-----
`

func TestSyntheticsCAConfigMapCarriesCertificateOnly(t *testing.T) {
	if syntheticsCAConfigMap("") != nil || syntheticsCAConfigMap("not pem") != nil {
		t.Fatal("no certificate: no ConfigMap")
	}
	withKey := testCA + "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIA==\n-----END EC PRIVATE KEY-----\n"
	cm := syntheticsCAConfigMap(withKey)
	if cm == nil {
		t.Fatal("certificate present: ConfigMap expected")
	}
	data := cm["data"].(map[string]string)["ca.crt"]
	if !strings.Contains(data, "BEGIN CERTIFICATE") || strings.Contains(data, "PRIVATE KEY") {
		t.Fatalf("ConfigMap must hold the certificate and never a key:\n%s", data)
	}
	meta := cm["metadata"].(map[string]any)
	if meta["name"] != "platform-ca" || meta["namespace"] != "synthetics" {
		t.Fatalf("unexpected metadata %v", meta)
	}
}
