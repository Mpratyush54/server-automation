package images

import (
	"context"
	"strings"
)

// haOnlyPrefix marks images only needed on the ha profile (kube-vip).
const haOnlyPrefix = "ghcr.io/kube-vip/kube-vip:"

// ListForTelemetry keeps the complete offline inventory, but avoids downloading
// full-only images during a minimal/standard online install.
func ListForTelemetry(full bool) []string {
	var out []string
	for _, img := range List() {
		normalized := strings.TrimPrefix(img, "docker.io/")
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

// ListForInstall is ListForTelemetry plus an ha gate: kube-vip is skipped unless ha.
func ListForInstall(full, ha bool) []string {
	var out []string
	for _, img := range ListForTelemetry(full) {
		if !ha && strings.HasPrefix(img, haOnlyPrefix) {
			continue
		}
		out = append(out, img)
	}
	return out
}

func PrePullForInstall(ctx context.Context, concurrency int, full, ha bool, extra ...string) Result {
	return prePullList(ctx, concurrency, ListForInstall(full, ha), extra...)
}
