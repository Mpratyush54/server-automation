package config

import (
	"fmt"
	"strconv"
	"strings"
)

// Cluster holds the multi-node settings of the ha profile (#53). They are read
// on every node (first server and joiners) and only saved to .env when the
// profile is ha, so single-node installs keep exactly the .env they had.
type Cluster struct {
	// Nodes lists the IPs or CIDRs of every cluster node (PLATFORM_CLUSTER_NODES,
	// comma separated). The host firewall opens the etcd, API, kubelet and
	// flannel ports to these sources only.
	Nodes []string
	// APISANs are extra names/IPs for the Kubernetes API certificate, e.g. the
	// API virtual IP or a DNS name in front of the servers (PLATFORM_API_SANS).
	APISANs []string
	// NodeIP pins the address k3s advertises (PLATFORM_NODE_IP), useful when a
	// node has a private network next to its public address.
	NodeIP string

	// Embedded etcd snapshots (k3s etcd-snapshot-*). Cron defaults to every
	// 6 hours, retention to 28 snapshots (one week).
	EtcdSnapshotCron      string
	EtcdSnapshotRetention int
	// Optional S3/MinIO target for the snapshots. Enabled when endpoint and
	// bucket are set. Use an off-site bucket: bundled MinIO lives in the
	// cluster it would have to restore.
	EtcdS3Endpoint  string
	EtcdS3Bucket    string
	EtcdS3Region    string
	EtcdS3Folder    string
	EtcdS3AccessKey string
	EtcdS3SecretKey string
}

const (
	defaultEtcdSnapshotCron      = "0 */6 * * *"
	defaultEtcdSnapshotRetention = 28
)

// loadCluster reads the cluster settings from the environment (and the saved
// .env merged into it by Load).
func (c *Config) loadCluster() {
	c.Cluster = Cluster{
		Nodes:                 SplitList(getEnv("PLATFORM_CLUSTER_NODES", "")),
		APISANs:               SplitList(getEnv("PLATFORM_API_SANS", "")),
		NodeIP:                strings.TrimSpace(getEnv("PLATFORM_NODE_IP", "")),
		EtcdSnapshotCron:      strings.TrimSpace(getEnv("ETCD_SNAPSHOT_CRON", defaultEtcdSnapshotCron)),
		EtcdSnapshotRetention: parseRetention(getEnv("ETCD_SNAPSHOT_RETENTION", "")),
		EtcdS3Endpoint:        strings.TrimSpace(getEnv("ETCD_S3_ENDPOINT", "")),
		EtcdS3Bucket:          strings.TrimSpace(getEnv("ETCD_S3_BUCKET", "")),
		EtcdS3Region:          strings.TrimSpace(getEnv("ETCD_S3_REGION", "")),
		EtcdS3Folder:          strings.TrimSpace(getEnv("ETCD_S3_FOLDER", "")),
		EtcdS3AccessKey:       strings.TrimSpace(getEnv("ETCD_S3_ACCESS_KEY", "")),
		EtcdS3SecretKey:       strings.TrimSpace(getEnv("ETCD_S3_SECRET_KEY", "")),
	}
}

func parseRetention(v string) int {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 1 {
		return defaultEtcdSnapshotRetention
	}
	return n
}

// SplitList splits a comma separated list, trimming spaces and dropping empty items.
func SplitList(v string) []string {
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// clusterEnv renders the cluster keys for SaveEnvFile ("" unless ha).
func (c *Config) clusterEnv() (string, error) {
	if !c.IsHA() {
		return "", nil
	}
	cl := c.Cluster
	values := []string{
		strings.Join(cl.Nodes, ","), strings.Join(cl.APISANs, ","), cl.NodeIP,
		cl.EtcdSnapshotCron, cl.EtcdS3Endpoint, cl.EtcdS3Bucket, cl.EtcdS3Region,
		cl.EtcdS3Folder, cl.EtcdS3AccessKey, cl.EtcdS3SecretKey,
	}
	for _, v := range values {
		if strings.ContainsAny(v, "\r\n") {
			return "", fmt.Errorf("cluster settings cannot contain line breaks")
		}
	}
	retention := cl.EtcdSnapshotRetention
	if retention < 1 {
		retention = defaultEtcdSnapshotRetention
	}
	var b strings.Builder
	fmt.Fprintf(&b, "PLATFORM_CLUSTER_NODES=%s\n", values[0])
	fmt.Fprintf(&b, "PLATFORM_API_SANS=%s\n", values[1])
	fmt.Fprintf(&b, "PLATFORM_NODE_IP=%s\n", values[2])
	fmt.Fprintf(&b, "ETCD_SNAPSHOT_CRON=%s\n", values[3])
	fmt.Fprintf(&b, "ETCD_SNAPSHOT_RETENTION=%d\n", retention)
	fmt.Fprintf(&b, "ETCD_S3_ENDPOINT=%s\n", values[4])
	fmt.Fprintf(&b, "ETCD_S3_BUCKET=%s\n", values[5])
	fmt.Fprintf(&b, "ETCD_S3_REGION=%s\n", values[6])
	fmt.Fprintf(&b, "ETCD_S3_FOLDER=%s\n", values[7])
	fmt.Fprintf(&b, "ETCD_S3_ACCESS_KEY=%s\n", values[8])
	fmt.Fprintf(&b, "ETCD_S3_SECRET_KEY=%s\n", values[9])
	return b.String(), nil
}
