package images

import (
	"slices"
	"strings"
	"testing"
)

func TestFullOnlyTelemetryImages(t *testing.T) {
	light, full := ListForTelemetry(false), ListForTelemetry(true)
	if !slices.Equal(full, List()) {
		t.Fatal("offline inventory changed")
	}
	for _, img := range full {
		for _, backend := range []string{"grafana/alloy:", "grafana/tempo:", "grafana/pyroscope:", "grafana/loki:3.", "blackbox-exporter:", "minio/mc:"} {
			if strings.Contains(img, backend) && slices.Contains(light, img) {
				t.Fatal("full image in light profile", img)
			}
		}
	}
	if !slices.Contains(light, "grafana/loki:2.6.1") {
		t.Fatal("removed standard Loki")
	}
	if len(full)-len(light) != 6 {
		t.Fatal("missing telemetry images")
	}
}
