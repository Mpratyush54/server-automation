package components

import (
	"fmt"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

const kedaChartVersion = "2.18.1"
const httpAddonChartVersion = "0.11.1"

func KEDAEnabled(c *config.Config) bool {
	return c.InstallKEDA && config.FullFeatures(c.Profile) && c.InstallMonitoring
}

// kedaInstallArgs is pure so profile gates and resource settings are tested offline.
func kedaInstallArgs(http bool) []string {
	release, chartName, version := "keda", "keda", kedaChartVersion
	if http {
		release, chartName, version = "keda-add-ons-http", "keda-add-ons-http", httpAddonChartVersion
	}
	args := []string{"upgrade", "--install", release, chartName, "--repo", "https://kedacore.github.io/charts", "--version", version,
		"--namespace", "keda", "--create-namespace", "--wait", "--timeout", "10m"}
	prefixes := []string{"resources.operator", "resources.metricServer", "resources.webhooks"}
	if http {
		prefixes = []string{"operator.resources", "scaler.resources", "interceptor.resources"}
		args = append(args, "--set", "operator.replicas=1", "--set", "scaler.replicas=1", "--set", "interceptor.replicas.min=1", "--set", "interceptor.replicas.max=1",
			"--set", "interceptor.replicas.waitTimeout=60s", "--set", "interceptor.responseHeaderTimeout=30s")
	}
	for _, prefix := range prefixes {
		for _, entry := range []string{"requests.cpu=50m", "requests.memory=64Mi", "limits.cpu=500m", "limits.memory=256Mi"} {
			args = append(args, "--set", prefix+"."+entry)
		}
	}
	return args
}

// InstallKEDA runs after telemetry so Prometheus and its monitoring CRDs exist.
func InstallKEDA(c *config.Config) error {
	if !KEDAEnabled(c) {
		return nil
	}
	for _, http := range []bool{false, true} {
		args := kedaInstallArgs(http)
		clearStuckHelmRelease(args[2], "keda") // args: upgrade --install <release> ...
		if err := shell.Run("helm", args...); err != nil {
			return fmt.Errorf("install autoscaling: %w", err)
		}
	}
	if _, err := shell.RunWithInput("kubectl", []string{"apply", "-f", "-"}, readManifest("autoscaling-monitoring.yaml")); err != nil {
		return fmt.Errorf("autoscaling monitoring: %w", err)
	}
	return state.MarkDone("keda")
}
