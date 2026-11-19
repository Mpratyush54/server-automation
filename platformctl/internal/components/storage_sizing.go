package components

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// Longhorn defaults platformctl installs (longhorn-values.yaml): 30% of each
// disk reserved, and replicas scheduled up to 200% of the rest.
const (
	longhornReservedFraction = 0.30
	longhornOverProvisioning = 2.0
	// MinIO's share of the cluster's schedulable Longhorn space. The other
	// platform volumes (MongoDB, Redis, telemetry, Portainer) need about 95 GiB
	// with their replicas; the rest stays free for user volumes and rebuilds.
	minioLonghornShare = 0.35
	minioMinDriveGi    = 8
	minioMaxDriveGi    = 50
	// ha clusters start with three servers; MinIO drives keep two Longhorn
	// replicas while there are fewer nodes than drives (MinioStorageReplicaCount).
	haServers           = 3
	minioDriveReplicas  = 2
	portainerVolumeSize = "2Gi"
)

// minioHADriveSizeGi sizes each MinIO drive on ha from the disk that backs
// Longhorn. A fixed 25Gi made MinIO alone request 200 GiB (4 drives x 2
// replicas) of the 321 GiB three 80 GB servers can schedule, so the platform's
// own volumes filled Longhorn to 100% and the telemetry volumes created last
// could not place their replicas (degraded, or one replica). diskBytes <= 0
// (unknown) keeps the old 25Gi.
func minioHADriveSizeGi(diskBytes int64) int {
	if diskBytes <= 0 {
		return 25
	}
	perNode := float64(diskBytes) * (1 - longhornReservedFraction) * longhornOverProvisioning
	budget := minioLonghornShare * haServers * perNode
	size := int(budget / float64(MinioDrives*minioDriveReplicas) / (1 << 30))
	if size < minioMinDriveGi {
		return minioMinDriveGi
	}
	if size > minioMaxDriveGi {
		return minioMaxDriveGi
	}
	return size
}

// longhornDiskBytes is the size of the filesystem Longhorn stores replicas on
// (its storageMaximum), 0 when unknown.
var longhornDiskBytes = func() int64 {
	for _, path := range []string{"/var/lib/longhorn", "/"} {
		out, err := shell.Output("df", "-B1", "--output=size", path)
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if n, err := strconv.ParseInt(strings.TrimSpace(lines[len(lines)-1]), 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return 0
}

// existingPVCSize returns the requested size of a PVC that already exists
// ("" when it does not). StatefulSet claim templates are immutable and PVCs
// cannot shrink, so an installed volume keeps its size on re-runs and upgrades.
var existingPVCSize = func(namespace, name string) string {
	out, err := shell.Output("kubectl", "-n", namespace, "get", "pvc", name, "--ignore-not-found", "-o", "jsonpath={.spec.resources.requests.storage}")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// minioPersistSize is the MinIO drive size: 50Gi on a single server, sized from
// the disk on ha, and the current size when MinIO is already installed.
func minioPersistSize(cfg *config.Config) string {
	if !cfg.IsHA() {
		return "50Gi"
	}
	if size := existingPVCSize("storage", "data-minio-0"); size != "" {
		return size
	}
	return fmt.Sprintf("%dGi", minioHADriveSizeGi(longhornDiskBytes()))
}

// portainerPersistSize: Portainer keeps a small settings database; the chart's
// 10Gi default (x3 Longhorn replicas on ha) reserved 30 GiB for it.
func portainerPersistSize() string {
	if size := existingPVCSize("portainer", "portainer"); size != "" {
		return size
	}
	return portainerVolumeSize
}
