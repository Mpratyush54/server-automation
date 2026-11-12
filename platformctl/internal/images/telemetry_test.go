package images

import (
	"slices"
	"strings"
	"testing"
)

func TestFullOnlyTelemetryImages(t *testing.T) {
	light, full := ListForTelemetry(false), ListForTelemetry(true)
	if !slices.Equal(ListForProfile(true, true), List()) {
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

func TestListForProfileDropsKubeVIPUnlessHA(t *testing.T) {
	nonHA := ListForProfile(true, false)
	ha := ListForProfile(true, true)
	if slices.Contains(nonHA, "ghcr.io/kube-vip/kube-vip:v1.3.1") {
		t.Fatal("kube-vip must not pre-pull on non-ha")
	}
	if !slices.Contains(ha, "ghcr.io/kube-vip/kube-vip:v1.3.1") {
		t.Fatal("kube-vip missing on ha")
	}
	if !slices.Equal(ListForTelemetry(true), List()) {
		t.Fatal("ListForTelemetry must keep including kube-vip")
	}
	haOnly := 0
	for _, img := range ha {
		if isHAOnly(img) {
			haOnly++
		}
	}
	// kube-vip, Longhorn (#50), both CloudNativePG images (#51), and
	// redis-sentinel (#52) are the ha-only images.
	if haOnly != 17 || len(ha) != len(nonHA)+haOnly {
		t.Fatalf("ha=%d nonHA=%d haOnly=%d", len(ha), len(nonHA), haOnly)
	}
	if slices.Contains(nonHA, "registry-1.docker.io/bitnami/redis-sentinel:latest") {
		t.Fatal("redis-sentinel must not pre-pull on non-ha")
	}
	if !slices.Contains(ha, "registry-1.docker.io/bitnami/redis-sentinel:latest") {
		t.Fatal("redis-sentinel missing on ha")
	}
}

func TestCloudNativePGImagesHAOnly(t *testing.T) {
	for _, img := range []string{"ghcr.io/cloudnative-pg/cloudnative-pg:1.30.1", "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie"} {
		if slices.Contains(ListForProfile(true, false), img) || !slices.Contains(ListForProfile(true, true), img) {
			t.Fatal(img)
		}
	}
}
