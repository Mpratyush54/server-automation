package components

import (
	"fmt"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/apt"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"strings"
	"testing"
)

func TestLonghornReplicaCount(t *testing.T) {
	for _, tc := range []struct {
		nodes, override, want int
		warn                  bool
	}{
		{0, 0, 3, true}, {1, 0, 3, true}, {2, 0, 2, true}, {3, 0, 3, false}, {5, 0, 3, false},
		{1, 1, 1, false}, {1, 2, 2, true}, {2, 3, 3, true}, {5, 1, 1, false}, {5, 2, 2, false}, {5, 3, 3, false},
		{3, -1, 3, false}, {3, 4, 3, false},
	} {
		got, warning := LonghornReplicaCount(tc.nodes, tc.override)
		if got != tc.want || (warning != "") != tc.warn {
			t.Errorf("%+v: got %d %q", tc, got, warning)
		}
	}
	_, warning := LonghornReplicaCount(1, 0)
	for _, want := range []string{"degraded", "replicaAutoBalance", "platformctl install longhorn"} {
		if !strings.Contains(warning, want) {
			t.Error(warning)
		}
	}
	_, warning = LonghornReplicaCount(1, 3)
	if !strings.Contains(warning, "until 3 nodes are schedulable") {
		t.Error(warning)
	}
}

func TestCountReadyNodes(t *testing.T) {
	for _, tc := range []struct {
		out  string
		want int
	}{
		{"", 0}, {"node Ready server 1d v1\nnode2 NotReady worker 1d v1", 1},
		{"node Ready,SchedulingDisabled server 1d v1\nnode2 NotReady,SchedulingDisabled worker 1d v1", 0},
		{"a Ready x\nb Ready x\nc Ready,Other x\nmalformed", 3},
	} {
		if got := countReadyNodes(tc.out); got != tc.want {
			t.Errorf("%q: got %d want %d", tc.out, got, tc.want)
		}
	}
}

func TestDefaultStorageClasses(t *testing.T) {
	for _, tc := range []struct {
		data, want string
		fail       bool
	}{
		{`{"items":[]}`, "", false},
		{`{"items":[{"metadata":{"name":"longhorn","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}},{"metadata":{"name":"local-path","annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}]}`, "longhorn", false},
		{`{"items":[{"metadata":{"name":"a","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}},{"metadata":{"name":"b","annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}},{"metadata":{"name":"c"}}]}`, "a,b", false},
		{`{`, "", true},
	} {
		got, err := defaultStorageClasses(tc.data)
		if (err != nil) != tc.fail || strings.Join(got, ",") != tc.want {
			t.Errorf("%s: %v %v", tc.data, got, err)
		}
	}
}

func TestHAStorageClass(t *testing.T) {
	for _, profile := range config.Profiles {
		c := &config.Config{Profile: profile}
		want := ""
		if profile == config.ProfileHA {
			want = "longhorn"
		}
		if got := HAStorageClass(c); got != want {
			t.Errorf("%s: %q", profile, got)
		}
	}
}

func TestRenderLonghornValues(t *testing.T) {
	for _, tc := range []struct {
		target, secret string
		fail           bool
	}{
		{"", "", false}, {"", "unused-secret", false}, {"s3://backup-bucket@us-east-1/longhorn/", "backup-credentials", false},
		{"s3://bucket@region/", "", true}, {"https://bucket", "secret", true},
		{"s3://bucket@region/a,b", "secret", true}, {"s3://bucket@region/a\"", "secret", true},
		{"s3://bucket@region/a\n", "secret", true}, {"s3://bucket@region/a", "Bad_Name", true},
		{"s3://bucket@region/a", "-secret", true}, {"", "bad\nsecret", true},
		{"s3://bucket@region/a", strings.Repeat("a", 64), true},
	} {
		c := &config.Config{LonghornBackupTarget: tc.target, LonghornBackupSecret: tc.secret}
		out, err := renderLonghornValues(c, 2)
		if (err != nil) != tc.fail {
			t.Errorf("%+v: %v", tc, err)
		}
		if err != nil {
			continue
		}
		for _, want := range []string{`defaultClassReplicaCount: "2"`, `defaultReplicaCount: '{"v1":"2","v2":"2"}'`, "defaultClass: true", "ingress:\n  enabled: false", "replicaAutoBalance: best-effort", "type: ClusterIP"} {
			if !strings.Contains(out, want) {
				t.Errorf("missing %s", want)
			}
		}
		if strings.Contains(out, "{{") {
			t.Error("unresolved placeholder")
		}
		if strings.Contains(out, "defaultBackupStore:") != (tc.target != "") {
			t.Error("unexpected backup block")
		}
		if tc.target != "" && !strings.Contains(out, `backupTargetCredentialSecret: "`+tc.secret+`"`) {
			t.Error("missing secret name")
		}
	}
}

func TestLonghornScripts(t *testing.T) {
	script := longhornHelmScript("/tmp/values file.yaml")
	for _, want := range []string{"clear_helm_lock longhorn longhorn-system", "helm upgrade --install longhorn", "--version 1.12.1", "-f '/tmp/values file.yaml'", "--wait --timeout 15m"} {
		if !strings.Contains(script, want) {
			t.Errorf("missing %s", want)
		}
	}
	for _, want := range []string{"set -euo pipefail", "open-iscsi", "nfs-common", "util-linux", "dmsetup", "enable --now iscsid", "iscsi_tcp", "IET", "VIRTUAL-DISK", "reload multipathd || true"} {
		if !strings.Contains(apt.LonghornPrereqsScript, want) {
			t.Errorf("missing prereq %s", want)
		}
	}
	if strings.Contains(apt.LonghornPrereqsScript, "sd*") {
		t.Error("generic disk blacklist")
	}
	for _, want := range []string{"timeout 10m", "driver.longhorn.io", "storageclass longhorn", "deploy/csi-provisioner", "sleep 5"} {
		if !strings.Contains(longhornReadinessScript, want) {
			t.Errorf("missing readiness %s", want)
		}
	}
}

func TestMinioStorageReplicaCount(t *testing.T) {
	for nodes, want := range map[int]int{0: 2, 1: 2, 2: 2, 3: 2, 4: 1, 5: 1, 9: 1} {
		if got := MinioStorageReplicaCount(nodes); got != want {
			t.Errorf("nodes=%d: got %d replicas, want %d", nodes, got, want)
		}
	}
}

func TestLonghornMinioStorageClassManifest(t *testing.T) {
	for _, replicas := range []int{1, 2} {
		m := longhornMinioStorageClassManifest(replicas)
		for _, want := range []string{
			"kind: StorageClass",
			"name: longhorn-minio",
			"provisioner: driver.longhorn.io",
			fmt.Sprintf("numberOfReplicas: \"%d\"", replicas),
			"dataLocality: best-effort",
			`staleReplicaTimeout: "30"`,
			"allowVolumeExpansion: true",
		} {
			if !strings.Contains(m, want) {
				t.Errorf("replicas=%d: longhorn-minio manifest missing %q", replicas, want)
			}
		}
		// Longhorn stays the only default StorageClass.
		if strings.Contains(m, "is-default-class") {
			t.Error("longhorn-minio must not be a default StorageClass")
		}
	}
}

func TestMinioStorageClassNeedsRecreate(t *testing.T) {
	cases := []struct {
		current  string
		replicas int
		want     bool
	}{
		{"", 2, false},    // absent: plain apply
		{"2", 2, false},   // unchanged
		{"2\n", 2, false}, // trailing newline from kubectl
		{"2", 1, true},    // grew to 4+ nodes
		{"1", 2, true},    // shrank below 4 nodes
	}
	for _, c := range cases {
		if got := minioStorageClassNeedsRecreate(c.current, c.replicas); got != c.want {
			t.Errorf("current=%q replicas=%d: got %v want %v", c.current, c.replicas, got, c.want)
		}
	}
}

func TestLonghornSkipsNonHA(t *testing.T) {
	for _, profile := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull} {
		c := &config.Config{Profile: profile, InstallMonitoring: true}
		if err := InstallLonghorn(c); err != nil {
			t.Fatal(err)
		}
		if err := InstallLonghornMonitoring(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := InstallLonghornMonitoring(&config.Config{Profile: config.ProfileHA}); err != nil {
		t.Fatal(err)
	}
}

func TestLonghornMonitoringManifest(t *testing.T) {
	manifest := readManifest("longhorn-monitoring.yaml")
	for _, want := range []string{"kind: ServiceMonitor", "matchNames: [longhorn-system]", "release: kube-prometheus", "app: longhorn-manager", "port: manager", "kind: PrometheusRule", "namespace: monitoring", "name: longhorn.storage", "LonghornVolumeDegraded", "longhorn_volume_robustness == 2", "for: 10m", "LonghornVolumeFaulted", "longhorn_volume_robustness == 3", "for: 2m", "LonghornNodeNotReady", `longhorn_node_status{condition="ready"} == 0`, "for: 5m", "LonghornDiskUsageHigh", "longhorn_disk_usage_bytes / longhorn_disk_capacity_bytes > 0.85", "for: 15m", "{{ $labels.volume }}"} {
		if !strings.Contains(manifest, want) {
			t.Errorf("monitoring manifest missing %s", want)
		}
	}
}
