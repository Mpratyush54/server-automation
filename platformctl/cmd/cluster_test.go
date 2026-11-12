package cmd

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/preflight"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

const testToken = "K10" + "aa" + "::server:not-a-real-secret"

// clusterTest isolates the package globals the cluster commands use.
func clusterTest(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	state.SetPath(filepath.Join(dir, "state"))
	state.SetLockPath(filepath.Join(dir, "lock"))
	oldCfg := *cfg
	oldRole, oldRoot, oldJoin, oldPre := joinedRole, requireRoot, k3sJoin, joinPreflight
	oldHarden, oldUpsert, oldProv := joinHarden, upsertEnvKey, provisionedFn
	oldFlags := []string{joinRole, joinServer, joinTokenFile, joinNodes, joinNodeIP}
	t.Cleanup(func() {
		state.SetPath(state.DefaultPath)
		state.SetLockPath(state.DefaultLockPath)
		*cfg = oldCfg
		joinedRole, requireRoot, k3sJoin, joinPreflight = oldRole, oldRoot, oldJoin, oldPre
		joinHarden, upsertEnvKey, provisionedFn = oldHarden, oldUpsert, oldProv
		joinRole, joinServer, joinTokenFile, joinNodes, joinNodeIP = oldFlags[0], oldFlags[1], oldFlags[2], oldFlags[3], oldFlags[4]
	})
	joinedRole = func() string { return "" }
	requireRoot = func(string) error { return nil }
	provisionedFn = func() bool { return false }
	joinPreflight = func(host, role, token string) *preflight.Result { return &preflight.Result{Passed: true} }
	joinHarden = func() error { return nil }
	upsertEnvKey = func(path, k, v string) error { return nil }
	cfg.SkipHardening, cfg.SkipPreflight = false, false
	cfg.Cluster = config.Cluster{}
}

func TestK3sServerOptionsSingleNodeUnchanged(t *testing.T) {
	for _, p := range []string{config.ProfileMinimal, config.ProfileStandard, config.ProfileFull} {
		c := &config.Config{Profile: p, Cluster: config.Cluster{Nodes: []string{"10.0.0.1"}}}
		if o := k3sServerOptions(c); o.HA || k3s.RenderServerConfig(o) != k3s.ServerConfigYAML() {
			t.Errorf("%s: single-node k3s config must not change: %+v", p, o)
		}
	}
	c := &config.Config{Profile: config.ProfileHA, Cluster: config.Cluster{
		APISANs: []string{"k8s.example.com"}, NodeIP: "10.0.0.11",
		EtcdSnapshotCron: "0 */6 * * *", EtcdSnapshotRetention: 28, EtcdS3Endpoint: "s3.example.com", EtcdS3Bucket: "b",
	}}
	o := k3sServerOptions(c)
	if !o.HA || !o.ClusterInit || o.ServerURL != "" || o.TokenFile != k3s.ServerTokenFile || o.AgentTokenFile != k3s.AgentTokenFile {
		t.Fatalf("first server options: %+v", o)
	}
	if o.NodeIP != "10.0.0.11" || o.TLSSANs[0] != "k8s.example.com" || !o.Snapshots.S3Enabled() || o.Snapshots.Retention != 28 {
		t.Fatalf("cluster settings not mapped: %+v", o)
	}
	if err := o.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestCheckHAProvision(t *testing.T) {
	clusterTest(t)
	c := &config.Config{Profile: config.ProfileStandard}
	if err := checkHAProvision(c); err != nil {
		t.Fatalf("single node: %v", err)
	}
	c.Profile = config.ProfileHA
	if err := checkHAProvision(c); err == nil || !strings.Contains(err.Error(), "PLATFORM_CLUSTER_NODES") {
		t.Fatalf("ha without nodes and with hardening must fail, got %v", err)
	}
	c.SkipHardening = true
	if err := checkHAProvision(c); err != nil {
		t.Fatalf("ha with --skip-hardening needs no node list: %v", err)
	}
	c.SkipHardening = false
	c.Cluster.Nodes = []string{"0.0.0.0/0"}
	if err := checkHAProvision(c); err == nil {
		t.Fatal("an open-to-all node list must be rejected")
	}
	c.Cluster.Nodes = []string{"10.0.0.0/24"}
	c.Cluster.APISANs = []string{"bad name"}
	if err := checkHAProvision(c); err == nil {
		t.Fatal("invalid SAN must be rejected before provisioning")
	}
	c.Cluster.APISANs = nil
	if err := checkHAProvision(c); err != nil {
		t.Fatal(err)
	}
	joinedRole = func() string { return "agent" }
	if err := checkHAProvision(&config.Config{Profile: config.ProfileStandard}); err == nil {
		t.Fatal("provision must be refused on a joined node")
	}
}

func TestPrintJoinHint(t *testing.T) {
	var b bytes.Buffer
	printJoinHint(&b, &config.Config{Profile: config.ProfileFull})
	if b.Len() != 0 {
		t.Fatalf("no hint outside ha: %q", b.String())
	}
	printJoinHint(&b, &config.Config{Profile: config.ProfileHA, Cluster: config.Cluster{Nodes: []string{"10.0.0.11", "10.0.0.12"}}})
	for _, want := range []string{"token create --role server", "platformctl join", "--nodes 10.0.0.11,10.0.0.12"} {
		if !strings.Contains(b.String(), want) {
			t.Errorf("hint missing %q:\n%s", want, b.String())
		}
	}
}

func TestRunJoinAgent(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes, joinNodeIP = "agent", "https://10.0.0.11", "-", "10.0.0.11,10.0.0.21", "10.0.0.21"
	env := map[string]string{}
	upsertEnvKey = func(path, k, v string) error { env[k] = v; return nil }
	var gotRole k3s.Role
	var gotURL, gotToken string
	var gotOpts k3s.ServerOptions
	k3sJoin = func(role k3s.Role, url, token, gh string, o k3s.ServerOptions) error {
		gotRole, gotURL, gotToken, gotOpts = role, url, token, o
		return nil
	}
	var preHost string
	joinPreflight = func(host, role, token string) *preflight.Result {
		preHost = host
		return &preflight.Result{Passed: true}
	}
	hardened := false
	joinHarden = func() error { hardened = true; return nil }

	if err := runJoin(strings.NewReader(testToken + "\n")); err != nil {
		t.Fatal(err)
	}
	if gotRole != k3s.RoleAgent || gotURL != "https://10.0.0.11:6443" || gotToken != testToken || preHost != "10.0.0.11" {
		t.Fatalf("join called with %s %s token-ok=%t preflight=%s", gotRole, gotURL, gotToken == testToken, preHost)
	}
	if gotOpts.HA || gotOpts.NodeIP != "10.0.0.21" || gotOpts.Snapshots.S3Enabled() {
		t.Fatalf("agents get only the node IP: %+v", gotOpts)
	}
	if !hardened {
		t.Fatal("hardening must run by default")
	}
	if env["PLATFORM_PROFILE"] != "ha" || env["PLATFORM_CLUSTER_NODES"] != "10.0.0.11,10.0.0.21" || env["PLATFORM_HARDEN"] != "true" {
		t.Fatalf("saved env: %v", env)
	}
	for k, v := range env {
		if strings.Contains(v, "not-a-real-secret") {
			t.Fatalf("token persisted in .env key %s", k)
		}
	}
}

func TestRunJoinServerCarriesClusterSettings(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "server", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
	cfg.Cluster.APISANs = []string{"k8s.example.com"}
	cfg.Cluster.EtcdS3Endpoint, cfg.Cluster.EtcdS3Bucket = "s3.example.com", "snaps"
	var gotOpts k3s.ServerOptions
	k3sJoin = func(role k3s.Role, url, token, gh string, o k3s.ServerOptions) error { gotOpts = o; return nil }
	if err := runJoin(strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
	if !gotOpts.HA || gotOpts.TLSSANs[0] != "k8s.example.com" || !gotOpts.Snapshots.S3Enabled() {
		t.Fatalf("server join options: %+v", gotOpts)
	}
}

func TestRunJoinRefusals(t *testing.T) {
	joined := errors.New("k3s join must not run")
	cases := []struct {
		name  string
		setup func()
		want  string
	}{
		{"bad role", func() { joinRole = "master" }, "role"},
		{"http url", func() { joinServer = "http://10.0.0.11:6443" }, "--server"},
		{"provisioned host", func() { provisionedFn = func() bool { return true } }, "already runs the platform"},
		{"role change", func() { joinedRole = func() string { return "agent" }; joinRole = "server" }, "already joined as agent"},
		{"empty token", func() { joinTokenFile = "-" }, "--token-file"},
		{"no nodes with hardening", func() { joinNodes = "" }, "--nodes"},
		{"preflight", func() {
			joinPreflight = func(string, string, string) *preflight.Result {
				return &preflight.Result{Errors: []string{"cannot reach"}}
			}
		}, "pre-flight"},
		{"not root", func() { requireRoot = func(string) error { return errors.New("join requires Linux and root") } }, "root"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clusterTest(t)
			joinRole, joinServer, joinTokenFile, joinNodes = "agent", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
			k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error { return joined }
			tc.setup()
			stdin := testToken
			if tc.name == "empty token" {
				stdin = "\n"
			}
			err := runJoin(strings.NewReader(stdin))
			if err == nil || errors.Is(err, joined) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("want error containing %q before joining, got %v", tc.want, err)
			}
			if strings.Contains(err.Error(), "not-a-real-secret") {
				t.Fatal("error leaks the token")
			}
		})
	}
}

func TestRunJoinSkipHardening(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "agent", "https://10.0.0.11:6443", "-", ""
	cfg.SkipHardening = true
	k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error { return nil }
	joinHarden = func() error { t.Fatal("hardening must be skipped"); return nil }
	if err := runJoin(strings.NewReader(testToken)); err != nil {
		t.Fatal(err)
	}
}

func TestWriteToken(t *testing.T) {
	var out bytes.Buffer
	if err := writeToken(&out, testToken, ""); err != nil || out.String() != testToken+"\n" {
		t.Fatalf("stdout: %q %v", out.String(), err)
	}
	out.Reset()
	path := filepath.Join(t.TempDir(), "agent.token")
	if err := writeToken(&out, testToken, path); err != nil {
		t.Fatal(err)
	}
	if out.Len() != 0 {
		t.Fatal("token printed although --output was given")
	}
	data, err := os.ReadFile(path)
	if err != nil || strings.TrimSpace(string(data)) != testToken {
		t.Fatalf("file: %q %v", data, err)
	}
}

func TestWriteClusterStatus(t *testing.T) {
	nodes := []k3s.NodeInfo{
		{Name: "s1", Roles: []string{"control-plane", "etcd", "master"}, Ready: true, InternalIP: "10.0.0.11"},
		{Name: "s2", Roles: []string{"control-plane", "etcd", "master"}, Ready: false, InternalIP: "10.0.0.12"},
		{Name: "a1", Ready: true, InternalIP: "10.0.0.21"},
	}
	var b bytes.Buffer
	writeClusterStatus(&b, nodes, "ok")
	got := b.String()
	for _, want := range []string{"Cluster nodes (3), etcd: ok", "NotReady", "agent", "WARNING: 2 etcd servers"} {
		if !strings.Contains(got, want) {
			t.Errorf("status missing %q:\n%s", want, got)
		}
	}
}

func TestHardeningPortsAndNodeGuard(t *testing.T) {
	clusterTest(t)
	if got := strings.Join(hardeningPorts("server"), ","); got != "22,6443,10250" {
		t.Fatalf("server ports %s", got)
	}
	if got := strings.Join(hardeningPorts("agent"), ","); got != "22,10250" {
		t.Fatalf("agent ports %s", got)
	}
	old := listNodes
	t.Cleanup(func() { listNodes = old })
	listNodes = func() (string, error) { return "node/a\nnode/b\n", nil }

	cfg.Profile = config.ProfileStandard
	if err := checkHardenNodes(); err == nil {
		t.Fatal("multi-node without ha must be refused")
	}
	cfg.Profile = config.ProfileHA
	if err := checkHardenNodes(); err == nil {
		t.Fatal("ha multi-node without PLATFORM_CLUSTER_NODES must be refused")
	}
	cfg.Cluster.Nodes = []string{"10.0.0.0/24"}
	if err := checkHardenNodes(); err != nil {
		t.Fatal(err)
	}
	listNodes = func() (string, error) { return "node/a\n", nil }
	cfg.Profile, cfg.Cluster.Nodes = config.ProfileStandard, nil
	if err := checkHardenNodes(); err != nil {
		t.Fatalf("single node must stay allowed: %v", err)
	}
	joinedRole = func() string { return "agent" }
	listNodes = func() (string, error) { t.Fatal("agents have no kubeconfig"); return "", nil }
	cfg.Profile = config.ProfileHA
	if err := checkHardenNodes(); err == nil {
		t.Fatal("agent without node list must be refused")
	}
	cfg.Cluster.Nodes = []string{"10.0.0.11"}
	if err := checkHardenNodes(); err != nil {
		t.Fatal(err)
	}
}

func TestJoinEnvStripsLineBreaks(t *testing.T) {
	env := joinEnv(&config.Config{Cluster: config.Cluster{NodeIP: "10.0.0.1\nX=1"}})
	if strings.ContainsAny(env["PLATFORM_NODE_IP"], "\r\n") {
		t.Fatalf("line break kept: %q", env["PLATFORM_NODE_IP"])
	}
}
