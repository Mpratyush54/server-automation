package k3s

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func tokenPaths(t *testing.T) {
	t.Helper()
	a, b, c, d := ServerTokenFile, AgentTokenFile, DataTokenFile, DataAgentTokenFile
	t.Cleanup(func() { ServerTokenFile, AgentTokenFile, DataTokenFile, DataAgentTokenFile = a, b, c, d })
	dir := t.TempDir()
	ServerTokenFile, AgentTokenFile = filepath.Join(dir, "config", "server"), filepath.Join(dir, "config", "agent")
	DataTokenFile, DataAgentTokenFile = filepath.Join(dir, "data", "server"), filepath.Join(dir, "data", "agent")
	// Join tunes kernel limits before k3s starts: keep tests off the host.
	oldTune := joinTuneHost
	t.Cleanup(func() { joinTuneHost = oldTune })
	joinTuneHost = func() error { return nil }
}

func TestHAConfig(t *testing.T) {
	if got := RenderServerConfig(ServerOptions{TokenFile: "ignored"}); got != ServerConfigYAML() {
		t.Fatal(got)
	}
	o := ServerOptions{HA: true, ClusterInit: true, TokenFile: "/server", AgentTokenFile: "/agent", TLSSANs: []string{"a", "b"}, NodeIP: "10.0.0.1", Snapshots: EtcdSnapshots{Cron: "0 */12 * * *", Retention: 5, S3Endpoint: "s3.example", S3Bucket: "backups", S3Region: "region", S3Folder: "folder", S3AccessKey: "key", S3SecretKey: "secret\"\n"}}
	want := ServerConfigYAML() + "cluster-init: true\ntoken-file: \"/server\"\nagent-token-file: \"/agent\"\ntls-san:\n  - \"a\"\n  - \"b\"\nnode-ip: \"10.0.0.1\"\netcd-snapshot-schedule-cron: \"0 */12 * * *\"\netcd-snapshot-retention: 5\netcd-s3: true\netcd-s3-endpoint: \"s3.example\"\netcd-s3-bucket: \"backups\"\netcd-s3-region: \"region\"\netcd-s3-folder: \"folder\"\netcd-s3-access-key: \"key\"\netcd-s3-secret-key: \"secret\\\"\\n\"\n"
	if got := RenderServerConfig(o); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	o.ClusterInit = false
	o.ServerURL = "https://node:6443"
	o.Snapshots = EtcdSnapshots{S3Bucket: "bucket"}
	got := RenderServerConfig(o)
	if strings.Contains(got, "cluster-init") || strings.Contains(got, "etcd-s3") || !strings.Contains(got, "server: \"https://node:6443\"\n") {
		t.Fatal(got)
	}
	want = "# Managed by platformctl\nserver: \"https://node:6443\"\ntoken-file: \"/agent\"\nresolv-conf: " + ResolvConfPath + "\nnode-ip: \"::1\"\n"
	if got := RenderAgentConfig(AgentOptions{"https://node:6443", "/agent", "::1"}); got != want {
		t.Fatal(got)
	}
}

func TestValidation(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{{"https://node", "https://node:6443"}, {"https://node/", "https://node:6443"}, {"https://10.0.0.1:443", "https://10.0.0.1:443"}, {"https://[2001:db8::1]", "https://[2001:db8::1]:6443"}} {
		got, err := ValidateServerURL(tc.raw)
		if err != nil || got != tc.want {
			t.Fatalf("%s: %s %v", tc.raw, got, err)
		}
		if strings.ContainsAny(ServerHost(got), "[]") {
			t.Fatal(got)
		}
	}
	for _, raw := range []string{"", "http://node", "https://", "https://user:pass@node", "https://node/path", "https://node?x", "https://node#x", "https://node:", "https://node:0", "https://node:65536", "https://node:bad", "https://2001:db8::1:6443", "https://[node]:6443"} {
		if _, err := ValidateServerURL(raw); err == nil {
			t.Errorf("accepted %q", raw)
		}
	}
	for _, raw := range []string{"NODE.example", "a", "10.0.0.1", "::1"} {
		if err := ValidateSAN(raw); err != nil {
			t.Error(raw, err)
		}
	}
	for _, raw := range []string{"", "*.example", "a_", "-a", "a-", "a..b", strings.Repeat("a", 64), strings.Repeat("a.", 127) + "a"} {
		if ValidateSAN(raw) == nil {
			t.Errorf("accepted SAN %q", raw)
		}
	}
	if role, err := ParseRole(" AgEnT "); err != nil || role != RoleAgent {
		t.Fatal(role, err)
	}
	if _, err := ParseRole("worker"); err == nil {
		t.Fatal("invalid role")
	}
	base := ServerOptions{HA: true, ClusterInit: true, TokenFile: "/token"}
	if err := base.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*ServerOptions){func(o *ServerOptions) { o.ClusterInit = false }, func(o *ServerOptions) { o.ServerURL = "https://node" }, func(o *ServerOptions) { o.TokenFile = "" }, func(o *ServerOptions) { o.TLSSANs = []string{"*"} }, func(o *ServerOptions) { o.NodeIP = "node" }, func(o *ServerOptions) { o.Snapshots.Retention = -1 }, func(o *ServerOptions) { o.ClusterInit = false; o.ServerURL = "http://node" }} {
		o := base
		change(&o)
		if o.Validate() == nil {
			t.Fatalf("accepted %+v", o)
		}
	}
	if err := (ServerOptions{Snapshots: EtcdSnapshots{Retention: -1}}).Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestTokens(t *testing.T) {
	tokenPaths(t)
	for _, raw := range []string{"", " \n", "secret\nother", "secret other", "secret\tother", "secret\x00", strings.Repeat("x", 4097)} {
		if _, err := ParseToken([]byte(raw)); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("invalid token error: %v", err)
		}
	}
	if got, err := ParseToken([]byte(" \nabc\r\n")); err != nil || got != "abc" {
		t.Fatal(got, err)
	}
	a, err := GenerateToken()
	if err != nil || len(a) != 64 {
		t.Fatal(a, err)
	}
	b, _ := GenerateToken()
	if a == b {
		t.Fatal("reused token")
	}
	if err := WriteTokenFile(DataTokenFile, "old-secure"); err != nil {
		t.Fatal(err)
	}
	changed, err := EnsureServerTokens()
	if err != nil || !changed {
		t.Fatal(changed, err)
	}
	data, err := os.ReadFile(ServerTokenFile)
	if err != nil || string(data) != "old-secure\n" {
		t.Fatal(string(data), err)
	}
	if changed, err := EnsureServerTokens(); err != nil || changed {
		t.Fatal(changed, err)
	}
	if got, err := ReadToken(ServerTokenFile, nil); err != nil || got != "old-secure" {
		t.Fatal(got, err)
	}
	if got, err := ReadToken("-", strings.NewReader("abc\n")); err != nil || got != "abc" {
		t.Fatal(got, err)
	}
	if _, err := ReadToken("-", strings.NewReader(strings.Repeat("x", 9000))); err == nil {
		t.Fatal("unbounded input")
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(ServerTokenFile)
		if info.Mode().Perm() != 0600 {
			t.Fatal(info.Mode())
		}
		info, _ = os.Stat(filepath.Dir(ServerTokenFile))
		if info.Mode().Perm() != 0700 {
			t.Fatal(info.Mode())
		}
		if err := os.Chmod(ServerTokenFile, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadToken(ServerTokenFile, nil); err == nil || !strings.Contains(err.Error(), "chmod 600") {
			t.Fatal(err)
		}
	}
	if err := WriteTokenFile(DataAgentTokenFile, "agent-secure"); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadSecureToken(RoleAgent); err != nil || got != "agent-secure" {
		t.Fatal(got, err)
	}
	sum := sha256.Sum256([]byte("ca"))
	secure := fmt.Sprintf("K10%X::server:password", sum)
	if _, ok := TokenCAHash(secure); !ok || !CAHashMatches(secure, []byte("ca")) || CAHashMatches(secure, []byte("other")) || !CAHashMatches("short", nil) {
		t.Fatal("CA hash validation")
	}
	for _, token := range []string{"K10bad::server:password", "K10" + strings.Repeat("g", 64) + "::server:password", "K10" + strings.Repeat("a", 64)} {
		if _, ok := TokenCAHash(token); ok {
			t.Fatal("invalid secure token")
		}
	}
}

func TestEnsureTokensFreshAndInvalidData(t *testing.T) {
	tokenPaths(t)
	if changed, err := EnsureServerTokens(); err != nil || !changed {
		t.Fatal(changed, err)
	}
	server, _ := os.ReadFile(ServerTokenFile)
	agent, _ := os.ReadFile(AgentTokenFile)
	if len(strings.TrimSpace(string(server))) != 64 || string(server) == string(agent) {
		t.Fatal("independent tokens required")
	}
	if err := os.WriteFile(ServerTokenFile, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := WriteTokenFile(DataTokenFile, "preserve-me"); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureServerTokens(); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(ServerTokenFile); string(data) != "preserve-me\n" {
		t.Fatal(string(data))
	}
	if err := os.WriteFile(ServerTokenFile, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(DataTokenFile, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := EnsureServerTokens(); err == nil {
		t.Fatal("must not replace invalid datastore token")
	}
}

func TestParseNodesAndQuorum(t *testing.T) {
	nodes, err := ParseNodes([]byte(`{"items":[{"metadata":{"name":"z","labels":{"node-role.kubernetes.io/etcd":"","node-role.kubernetes.io/control-plane":""}},"status":{"conditions":[{"type":"Ready","status":"True"}],"addresses":[{"type":"ExternalIP","address":"outside"},{"type":"InternalIP","address":"10.0.0.1"}],"nodeInfo":{"kubeletVersion":"v1"}}},{"metadata":{"name":"a"},"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}`))
	if err != nil || len(nodes) != 2 {
		t.Fatal(nodes, err)
	}
	if nodes[0].Name != "a" || nodes[0].Ready || !nodes[1].Ready || nodes[1].InternalIP != "10.0.0.1" || nodes[1].Version != "v1" || !reflect.DeepEqual(nodes[1].Roles, []string{"control-plane", "etcd"}) || EtcdMembers(nodes) != 1 {
		t.Fatal(nodes)
	}
	if _, err := ParseNodes([]byte("broken")); err == nil {
		t.Fatal("invalid JSON")
	}
	for _, n := range []int{0, 3, 5, 7} {
		if QuorumWarning(n) != "" {
			t.Fatal(n)
		}
	}
	for _, n := range []int{1, 2, 4, 6} {
		if QuorumWarning(n) == "" {
			t.Fatal(n)
		}
	}
}

func TestWriteConfigPermissions(t *testing.T) {
	a, b, c := configDir, serverConfigPath, resolvConfPath
	t.Cleanup(func() { configDir, serverConfigPath, resolvConfPath = a, b, c })
	configDir = t.TempDir()
	serverConfigPath = filepath.Join(configDir, "config.yaml")
	resolvConfPath = filepath.Join(configDir, "resolv.conf")
	if changed, err := WriteConfig("secret config", []string{"1.1.1.1"}); err != nil || !changed {
		t.Fatal(changed, err)
	}
	if err := os.Chmod(serverConfigPath, 0644); err != nil {
		t.Fatal(err)
	}
	if changed, err := WriteConfig("secret config", []string{"1.1.1.1"}); err != nil || changed {
		t.Fatal(changed, err)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{serverConfigPath: 0600, resolvConfPath: 0644} {
			info, err := os.Stat(path)
			if err != nil || info.Mode().Perm() != want {
				t.Fatal(path, info, err)
			}
		}
	}
}
