package images

import (
	"context"
	"strings"
)

// haOnlyPrefixes mark images that only the ha profile needs: Longhorn
// replicated storage (#50) kube-vip for ingress HA (#54), and CloudNativePG PostgreSQL (#51). Prefixes are
// matched against the image reference with any "docker.io/" prefix removed.
var haOnlyPrefixes = []string{"ghcr.io/cloudnative-pg/", "longhornio/", "ghcr.io/kube-vip/kube-vip:"}

// isHAOnly reports whether img is only pulled on the ha profile.
func isHAOnly(img string) bool {
	normalized := strings.TrimPrefix(img, "docker.io/")
	for _, prefix := range haOnlyPrefixes {
		if strings.HasPrefix(normalized, prefix) {
			return true
		}
	}
	return false
}

// ListForTelemetry keeps the complete offline inventory (including ha-only
// images), but avoids downloading full-only telemetry images during a
// minimal/standard online install.
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

// ListForProfile is ListForTelemetry plus an ha gate: Longhorn, CloudNativePG and kube-vip
// images are skipped unless ha.
func ListForProfile(full, ha bool) []string {
	var out []string
	for _, img := range ListForTelemetry(full) {
		if !ha && isHAOnly(img) {
			continue
		}
		out = append(out, img)
	}
	return out
}

func PrePullForTelemetry(ctx context.Context, concurrency int, full bool, extra ...string) Result {
	return prePullList(ctx, concurrency, ListForTelemetry(full), extra...)
}

func PrePullForProfile(ctx context.Context, concurrency int, full, ha bool, extra ...string) Result {
	return prePullList(ctx, concurrency, ListForProfile(full, ha), extra...)
}
