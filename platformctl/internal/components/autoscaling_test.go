package components

import (
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

func TestKEDAProfileGate(t *testing.T) {
	for _, profile := range config.Profiles {
		for _, enabled := range []bool{false, true} {
			c := &config.Config{Profile: profile, InstallKEDA: enabled, InstallMonitoring: true}
			want := enabled && (profile == "full" || profile == "ha")
			if KEDAEnabled(c) != want {
				t.Fatalf("profile=%s enabled=%v", profile, enabled)
			}
			if !want {
				if err := InstallKEDA(c); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if KEDAEnabled(&config.Config{Profile: "full", InstallKEDA: true}) {
		t.Fatal("KEDA requires monitoring")
	}
}

func TestKEDAInstallResourcesAndPins(t *testing.T) {
	for _, http := range []bool{false, true} {
		args := strings.Join(kedaInstallArgs(http), " ")
		version := kedaChartVersion
		prefixes := []string{"resources.operator", "resources.metricServer", "resources.webhooks"}
		if http {
			version = httpAddonChartVersion
			prefixes = []string{"operator.resources", "scaler.resources", "interceptor.resources"}
			for _, setting := range []string{"scaler.replicas=1", "interceptor.replicas.min=1", "interceptor.replicas.max=1", "interceptor.replicas.waitTimeout=60s"} {
				if !strings.Contains(args, "--set "+setting) {
					t.Fatalf("missing %s", setting)
				}
			}
		}
		for _, setting := range []string{"--version " + version, "--namespace keda", "--repo https://kedacore.github.io/charts", "--wait"} {
			if !strings.Contains(args, setting) {
				t.Fatalf("missing %s", setting)
			}
		}
		for _, prefix := range prefixes {
			for _, field := range []string{"requests.cpu=50m", "requests.memory=64Mi", "limits.cpu=500m", "limits.memory=256Mi"} {
				if !strings.Contains(args, "--set "+prefix+"."+field) {
					t.Fatalf("missing %s.%s", prefix, field)
				}
			}
		}
	}
}

func TestAutoscalingIngressMetrics(t *testing.T) {
	c := &config.Config{Profile: "full", InstallKEDA: true, InstallMonitoring: true}
	controller := IngressSecurityValues(c)["controller"].(map[string]any)
	if controller["metrics"].(map[string]any)["enabled"] != true {
		t.Fatal("ingress request metrics must be enabled")
	}
	c.InstallKEDA = false
	if _, ok := IngressSecurityValues(c)["controller"].(map[string]any)["metrics"]; ok {
		t.Fatal("metrics should remain opt-in")
	}
	monitor := readManifest("autoscaling-monitoring.yaml")
	for _, fragment := range []string{"kind: PodMonitor", "release: kube-prometheus", "matchNames: [ingress-nginx]", "port: metrics", "honorLabels: true"} {
		if !strings.Contains(monitor, fragment) {
			t.Fatalf("missing scrape configuration %s", fragment)
		}
	}
}
