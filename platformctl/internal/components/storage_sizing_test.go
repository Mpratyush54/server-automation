package components

import (
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
)

const gib = int64(1) << 30

// measuredDiskGiB is storageMaximum on a t3.large with an 80 GB gp3 root volume.
var measuredDiskGiB = 76.4

func measuredDisk() int64 { return int64(measuredDiskGiB * float64(gib)) }

// Measured on a fresh 3 x t3.large (80 GB gp3) ha install: storageMaximum
// 76.4 GiB per node, limit (76.4-30%)*200% = 107 GiB per node, 321 GiB in all.
// With 25Gi drives the platform requested 320 GiB and the telemetry volumes
// could not place their third replica.
func TestMinioHADriveSizeFitsAnEightyGigabyteCluster(t *testing.T) {
	disk := measuredDisk()
	size := minioHADriveSizeGi(disk)
	if size != 14 {
		t.Fatalf("drive size on 76.4 GiB disks = %d Gi, want 14", size)
	}
	perNode := 76.4 * 0.7 * 2
	// MinIO (4 drives x 2 replicas) + MongoDB 3x10 + Redis 3x5 (one replica
	// each) + telemetry 3x5x3 + Portainer 2x3, as installed on ha.
	platform := float64(size*MinioDrives*2) + 30 + 15 + 45 + 6
	if share := platform / (3 * perNode); share > 0.70 {
		t.Fatalf("platform volumes take %.0f%% of schedulable Longhorn space; want <= 70%%", share*100)
	}
	// The busiest node also needs room for every telemetry replica.
	if platform/3+5 > perNode {
		t.Fatal("no room for a telemetry replica on an average node")
	}
}

func TestMinioHADriveSizeScalesAndClamps(t *testing.T) {
	cases := map[int64]int{
		0:          25, // unknown disk: previous fixed size
		30 * gib:   minioMinDriveGi,
		100 * gib:  18,
		200 * gib:  36,
		1024 * gib: minioMaxDriveGi,
	}
	for disk, want := range cases {
		if got := minioHADriveSizeGi(disk); got != want {
			t.Errorf("minioHADriveSizeGi(%d GiB) = %d, want %d", disk/gib, got, want)
		}
	}
}

func TestInstalledVolumesKeepTheirSize(t *testing.T) {
	oldPVC, oldDisk := existingPVCSize, longhornDiskBytes
	defer func() { existingPVCSize, longhornDiskBytes = oldPVC, oldDisk }()
	longhornDiskBytes = measuredDisk
	ha := &config.Config{Profile: config.ProfileHA}

	existingPVCSize = func(ns, name string) string { return "" }
	if got := minioPersistSize(ha); got != "14Gi" {
		t.Errorf("fresh ha MinIO = %s, want 14Gi", got)
	}
	if got := portainerPersistSize(); got != "2Gi" {
		t.Errorf("fresh Portainer = %s, want 2Gi", got)
	}
	if got := minioPersistSize(&config.Config{Profile: config.ProfileStandard}); got != "50Gi" {
		t.Errorf("single-server MinIO = %s, want 50Gi", got)
	}

	// An existing StatefulSet's claim template cannot change, and a PVC cannot shrink.
	existingPVCSize = func(ns, name string) string {
		if ns == "storage" && name == "data-minio-0" {
			return "25Gi"
		}
		if ns == "portainer" && name == "portainer" {
			return "10Gi"
		}
		return ""
	}
	if got := minioPersistSize(ha); got != "25Gi" {
		t.Errorf("upgraded ha MinIO = %s, want the installed 25Gi", got)
	}
	if got := portainerPersistSize(); got != "10Gi" {
		t.Errorf("upgraded Portainer = %s, want the installed 10Gi", got)
	}
}
