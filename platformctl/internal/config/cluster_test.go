package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

var clusterKeys = []string{
	"PLATFORM_CLUSTER_NODES", "PLATFORM_API_SANS", "PLATFORM_NODE_IP",
	"ETCD_SNAPSHOT_CRON", "ETCD_SNAPSHOT_RETENTION", "ETCD_S3_ENDPOINT", "ETCD_S3_BUCKET",
	"ETCD_S3_REGION", "ETCD_S3_FOLDER", "ETCD_S3_ACCESS_KEY", "ETCD_S3_SECRET_KEY",
}

func clusterEnvClean(t *testing.T) {
	t.Helper()
	for _, k := range clusterKeys {
		t.Setenv(k, "")
	}
}

func TestSplitList(t *testing.T) {
	got := SplitList(" 10.0.0.1, ,10.0.0.0/24 ,")
	if !reflect.DeepEqual(got, []string{"10.0.0.1", "10.0.0.0/24"}) {
		t.Fatalf("got %q", got)
	}
	if SplitList("") != nil {
		t.Fatal("empty list must be nil")
	}
}

func TestLoadClusterDefaultsAndOverrides(t *testing.T) {
	profileEnv(t, "")
	clusterEnvClean(t)
	c := Load()
	if c.Cluster.EtcdSnapshotCron != "0 */6 * * *" || c.Cluster.EtcdSnapshotRetention != 28 || c.Cluster.Nodes != nil {
		t.Fatalf("defaults: %+v", c.Cluster)
	}
	t.Setenv("PLATFORM_CLUSTER_NODES", "10.0.0.11,10.0.0.12, 10.0.0.13")
	t.Setenv("PLATFORM_API_SANS", "k8s.example.com,10.0.0.100")
	t.Setenv("ETCD_SNAPSHOT_RETENTION", "nope")
	t.Setenv("ETCD_S3_BUCKET", "snaps")
	c = Load()
	if len(c.Cluster.Nodes) != 3 || c.Cluster.APISANs[1] != "10.0.0.100" || c.Cluster.EtcdS3Bucket != "snaps" {
		t.Fatalf("overrides: %+v", c.Cluster)
	}
	if c.Cluster.EtcdSnapshotRetention != 28 {
		t.Fatalf("invalid retention must fall back to the default, got %d", c.Cluster.EtcdSnapshotRetention)
	}
}

// Single-node profiles must keep exactly the .env they had before #53.
func TestSaveEnvFileClusterKeysOnlyForHA(t *testing.T) {
	profileEnv(t, "")
	clusterEnvClean(t)
	t.Setenv("PLATFORM_CLUSTER_NODES", "10.0.0.11")
	for _, profile := range []string{ProfileMinimal, ProfileStandard, ProfileFull} {
		c := Load()
		if err := c.ApplyProfile(profile); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(t.TempDir(), ".env")
		if err := c.SaveEnvFile(path); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(path)
		for _, k := range clusterKeys {
			if strings.Contains(string(data), k+"=") {
				t.Errorf("%s profile saved %s", profile, k)
			}
		}
	}

	c := Load()
	if err := c.ApplyProfile(ProfileHA); err != nil {
		t.Fatal(err)
	}
	c.Cluster.APISANs = []string{"k8s.example.com"}
	c.Cluster.EtcdS3SecretKey = "s3cret"
	path := filepath.Join(t.TempDir(), ".env")
	if err := c.SaveEnvFile(path); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	for _, want := range []string{"PLATFORM_CLUSTER_NODES=10.0.0.11\n", "PLATFORM_API_SANS=k8s.example.com\n",
		"ETCD_SNAPSHOT_RETENTION=28\n", "ETCD_S3_SECRET_KEY=s3cret\n"} {
		if !strings.Contains(string(data), want) {
			t.Errorf("ha .env missing %q", want)
		}
	}

	// Round trip through the saved file.
	clusterEnvClean(t)
	for _, k := range clusterKeys {
		os.Unsetenv(k)
	}
	profileEnv(t, string(data))
	c2 := Load()
	if !c2.IsHA() || !reflect.DeepEqual(c2.Cluster.Nodes, []string{"10.0.0.11"}) || c2.Cluster.EtcdS3SecretKey != "s3cret" {
		t.Fatalf("round trip: %+v", c2.Cluster)
	}

	c.Cluster.NodeIP = "10.0.0.1\nINJECT=1"
	if err := c.SaveEnvFile(path); err == nil {
		t.Fatal("line breaks in cluster settings must be rejected")
	}
}
