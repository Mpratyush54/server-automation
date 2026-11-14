package k3s

import (
	"strings"
	"testing"
)

// The external backup target reaches k3s as a Secret name only (#186).
func TestEtcdS3ConfigSecret(t *testing.T) {
	o := ServerOptions{HA: true, ClusterInit: true, TokenFile: "/t", Snapshots: EtcdSnapshots{S3ConfigSecret: "platform-etcd-s3"}}
	s := RenderServerConfig(o)
	if !strings.Contains(s, "etcd-s3: true\n") || !strings.Contains(s, `etcd-s3-config-secret: "platform-etcd-s3"`) || strings.Contains(s, "etcd-s3-access-key") {
		t.Fatal(s)
	}
	// Explicit ETCD_S3_* settings keep precedence.
	o.Snapshots.S3Endpoint, o.Snapshots.S3Bucket = "s3.example.com", "etcd"
	s = RenderServerConfig(o)
	if strings.Contains(s, "etcd-s3-config-secret") || !strings.Contains(s, `etcd-s3-bucket: "etcd"`) {
		t.Fatal(s)
	}
	// Single-node (SQLite) has no etcd snapshots.
	if strings.Contains(RenderServerConfig(ServerOptions{Snapshots: EtcdSnapshots{S3ConfigSecret: "x"}}), "etcd-s3") {
		t.Fatal("single node")
	}
}
