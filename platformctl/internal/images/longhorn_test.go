package images

import (
	"slices"
	"strings"
	"testing"
)

func TestLonghornImages(t *testing.T) {
	expected := []string{
		"backing-image-manager:v1.12.1", "csi-attacher:v4.12.0", "csi-node-driver-registrar:v2.17.0", "csi-provisioner:v5.3.0", "csi-resizer:v2.2.1", "csi-snapshotter:v8.6.0", "livenessprobe:v2.19.0", "longhorn-engine:v1.12.1", "longhorn-instance-manager:v1.12.1", "longhorn-manager:v1.12.1", "longhorn-share-manager:v1.12.1", "longhorn-ui:v1.12.1", "support-bundle-kit:v0.0.92",
	}
	for _, img := range expected {
		if !slices.Contains(List(), "longhornio/"+img) {
			t.Errorf("missing %s", img)
		}
	}
	for _, tc := range []struct{ full, ha bool }{{false, false}, {true, false}, {false, true}, {true, true}} {
		selected := ListForProfile(tc.full, tc.ha)
		n := 0
		for _, img := range selected {
			if strings.HasPrefix(strings.TrimPrefix(img, "docker.io/"), "longhornio/") {
				n++
			}
		}
		want := 0
		if tc.ha {
			want = 13
		}
		if n != want {
			t.Errorf("%+v: got %d Longhorn images", tc, n)
		}
		if !tc.ha && !slices.Equal(selected, ListForTelemetry(tc.full)) {
			t.Error("telemetry wrapper changed")
		}
	}
}
