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
		for _, backend := range []string{"grafana/alloy:", "grafana/tempo:", "grafana/pyroscope:", "grafana/loki:3.", "blackbox-exporter:"} {
			if strings.Contains(img, backend) && slices.Contains(light, img) {
				t.Fatal("full image in light profile", img)
			}
		}
	}
	if !slices.Contains(light, "grafana/loki:2.6.1") {
		t.Fatal("removed standard Loki")
	}
	if len(full)-len(light) != 5 { // alloy, tempo, pyroscope, loki 3, blackbox-exporter (mc comes from the MinIO image)
		t.Fatal("missing telemetry images")
	}
}

func TestListForInstallDropsKubeVIPUnlessHA(t *testing.T) {
	nonHA := ListForInstall(true, false)
	ha := ListForInstall(true, true)
	if slices.Contains(nonHA, "ghcr.io/kube-vip/kube-vip:v1.3.1") {
		t.Fatal("kube-vip must not pre-pull on non-ha")
	}
	if !slices.Contains(ha, "ghcr.io/kube-vip/kube-vip:v1.3.1") {
		t.Fatal("kube-vip missing on ha")
	}
	if !slices.Equal(ListForTelemetry(true), List()) {
		t.Fatal("ListForTelemetry must keep including kube-vip")
	}
	if len(ha) != len(nonHA)+1 {
		t.Fatalf("ha=%d nonHA=%d", len(ha), len(nonHA))
	}
}
