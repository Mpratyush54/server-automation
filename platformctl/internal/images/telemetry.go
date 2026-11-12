package images

import (
	"context"
	"strings"
)

// ListForTelemetry selects images for a non-HA install, including full-only
// telemetry images when requested. List retains the complete offline inventory.
func ListForTelemetry(full bool) []string { return ListForProfile(full, false) }

// ListForProfile selects telemetry and HA storage images for online installs.
func ListForProfile(full, ha bool) []string {
	var out []string
	for _, img := range List() {
		normalized := strings.TrimPrefix(img, "docker.io/")
		if !ha && strings.HasPrefix(normalized, "longhornio/") {
			continue
		}
		telemetry := false
		for _, prefix := range []string{"grafana/alloy:", "grafana/tempo:", "grafana/pyroscope:", "grafana/loki:3.", "quay.io/prometheus/blackbox-exporter:"} {
			if strings.HasPrefix(normalized, prefix) {
				telemetry = true
				break
			}
		}
		if full || !telemetry {
			out = append(out, img)
		}
	}
	return out
}

func PrePullForTelemetry(ctx context.Context, concurrency int, full bool, extra ...string) Result {
	return prePullList(ctx, concurrency, ListForTelemetry(full), extra...)
}

func PrePullForProfile(ctx context.Context, concurrency int, full, ha bool, extra ...string) Result {
	return prePullList(ctx, concurrency, ListForProfile(full, ha), extra...)
}
