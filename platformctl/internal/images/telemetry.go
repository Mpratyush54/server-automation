package images

import (
	"context"
	"strings"
)

// ListForTelemetry keeps the complete offline inventory, but avoids downloading
// full-only images during a minimal/standard online install.
func ListForTelemetry(full bool) []string {
	var out []string
	for _, img := range List() {
		normalized := strings.TrimPrefix(img, "docker.io/")
		telemetry := false
		for _, prefix := range []string{"grafana/alloy:", "grafana/tempo:", "grafana/pyroscope:", "grafana/loki:3.", "quay.io/prometheus/blackbox-exporter:", "quay.io/minio/mc:"} {
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
