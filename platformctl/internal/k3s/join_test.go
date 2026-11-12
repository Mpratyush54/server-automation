package k3s

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func TestJoin(t *testing.T) {
	for _, role := range []Role{RoleServer, RoleAgent} {
		for _, installed := range []bool{false, true} {
			for _, changed := range []bool{false, true} {
				t.Run(string(role)+"/"+map[bool]string{true: "installed", false: "new"}[installed]+"/"+map[bool]string{true: "changed", false: "same"}[changed], func(t *testing.T) {
					tokenPaths(t)
					state.SetPath(filepath.Join(t.TempDir(), "state"))
					t.Cleanup(func() { state.SetPath(state.DefaultPath) })
					a, b, c, d, e, f, g, h, i := joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig, joinWaitAgent
					t.Cleanup(func() {
						joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig, joinWaitAgent = a, b, c, d, e, f, g, h, i
					})
					var calls []string
					path, service, exec := ServerTokenFile, "k3s", ""
					if role == RoleAgent {
						path, service, exec = AgentTokenFile, "k3s-agent", "agent"
					}
					joinWriteToken = func(p, token string) error {
						if p != path || token != "secret-token" {
							t.Fatal("wrong token write")
						}
						calls = append(calls, "token")
						return nil
					}
					joinWriteRegistries = func(token string) (bool, error) {
						if token != "github" {
							t.Fatal(token)
						}
						calls = append(calls, "registries")
						return false, nil
					}
					o := ServerOptions{TLSSANs: []string{"api.example"}, NodeIP: "10.0.0.2", Snapshots: EtcdSnapshots{Retention: 3}}
					joinWriteConfig = func(content string, servers []string) (bool, error) {
						var want string
						if role == RoleServer {
							want = RenderServerConfig(ServerOptions{HA: true, ServerURL: "https://node:6443", TokenFile: ServerTokenFile, TLSSANs: o.TLSSANs, NodeIP: o.NodeIP, Snapshots: o.Snapshots})
						} else {
							want = RenderAgentConfig(AgentOptions{"https://node:6443", AgentTokenFile, o.NodeIP})
						}
						if content != want || len(servers) == 0 {
							t.Fatalf("unexpected config:\n%s", content)
						}
						calls = append(calls, "config")
						return changed, nil
					}
					joinIsInstalled = func() bool { return installed }
					joinInstall = func(s string) error {
						if s != exec {
							t.Fatal(s)
						}
						calls = append(calls, "install")
						return nil
					}
					joinRestart = func(s string) error {
						if s != service {
							t.Fatal(s)
						}
						calls = append(calls, "restart")
						return nil
					}
					joinWaitReady = func() error { calls = append(calls, "server-ready"); return nil }
					joinSetupKubeconfig = func() error { calls = append(calls, "kubeconfig"); return nil }
					joinWaitAgent = func() error { calls = append(calls, "agent-ready"); return nil }
					if err := Join(role, "https://node", " secret-token\n", "github", o); err != nil {
						t.Fatal(err)
					}
					want := []string{"token", "registries", "config"}
					if !installed {
						want = append(want, "install")
					} else if changed {
						want = append(want, "restart")
					}
					if role == RoleServer {
						want = append(want, "server-ready", "kubeconfig")
					} else {
						want = append(want, "agent-ready")
					}
					if !reflect.DeepEqual(calls, want) || state.Get("cluster-role") != string(role) || !state.IsDone("k3s") {
						t.Fatal(calls, want)
					}
				})
			}
		}
	}
}

func TestJoinRejectsBeforeSideEffects(t *testing.T) {
	old := joinWriteToken
	t.Cleanup(func() { joinWriteToken = old })
	joinWriteToken = func(string, string) error { t.Fatal("unexpected side effect"); return nil }
	for _, tc := range []struct {
		role       Role
		url, token string
		o          ServerOptions
	}{
		{RoleServer, "http://node", "secret", ServerOptions{}},
		{RoleAgent, "https://node", "secret invalid", ServerOptions{}},
		{RoleServer, "https://node", "secret", ServerOptions{TLSSANs: []string{"*"}}},
		{RoleAgent, "https://node", "secret", ServerOptions{NodeIP: "bad"}},
		{"unknown", "https://node", "secret", ServerOptions{}},
	} {
		err := Join(tc.role, tc.url, tc.token, "", tc.o)
		if err == nil || strings.Contains(err.Error(), tc.token) {
			t.Fatal(err)
		}
	}
}

func TestJoinFailuresDoNotMarkDoneOrLeakToken(t *testing.T) {
	for _, stage := range []string{"token", "registries", "config", "install", "restart", "server-ready", "kubeconfig", "agent-ready"} {
		t.Run(stage, func(t *testing.T) {
			state.SetPath(filepath.Join(t.TempDir(), "state"))
			t.Cleanup(func() { state.SetPath(state.DefaultPath) })
			a, b, c, d, e, f, g, h, i := joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig, joinWaitAgent
			t.Cleanup(func() {
				joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig, joinWaitAgent = a, b, c, d, e, f, g, h, i
			})
			fail := func(name string) error {
				if name == stage {
					return errors.New("failure mentioning secret-token")
				}
				return nil
			}
			joinWriteToken = func(string, string) error { return fail("token") }
			joinWriteRegistries = func(string) (bool, error) { return false, fail("registries") }
			joinWriteConfig = func(string, []string) (bool, error) { return true, fail("config") }
			joinInstall = func(string) error { return fail("install") }
			joinIsInstalled = func() bool { return stage == "restart" }
			joinRestart = func(string) error { return fail("restart") }
			joinWaitReady = func() error { return fail("server-ready") }
			joinSetupKubeconfig = func() error { return fail("kubeconfig") }
			joinWaitAgent = func() error { return fail("agent-ready") }
			role := RoleServer
			if stage == "agent-ready" {
				role = RoleAgent
			}
			err := Join(role, "https://node", "secret-token", "", ServerOptions{})
			if err == nil || strings.Contains(err.Error(), "secret-token") || state.IsDone("k3s") || state.Get("cluster-role") != "" {
				t.Fatal(err, state.Get("cluster-role"))
			}
		})
	}
}

func TestTokenOperations(t *testing.T) {
	tokenPaths(t)
	a, b, c := runRotate, runCreate, joinRestart
	t.Cleanup(func() { runRotate, runCreate, joinRestart = a, b, c })
	if err := WriteTokenFile(DataTokenFile, "old"); err != nil {
		t.Fatal(err)
	}
	runRotate = func() error { return WriteTokenFile(DataTokenFile, "new") }
	if token, err := RotateServerToken(); err != nil || token != "new" {
		t.Fatal(token, err)
	}
	if data, _ := os.ReadFile(ServerTokenFile); string(data) != "new\n" {
		t.Fatal(string(data))
	}
	runRotate = func() error { return nil }
	if _, err := RotateServerToken(); err == nil {
		t.Fatal("unchanged rotation")
	}
	runRotate = func() error { return errors.New("secret") }
	if _, err := RotateServerToken(); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
	runCreate = func(ttl string) (string, error) {
		if ttl != "10m" && ttl != "720h" {
			t.Fatal(ttl)
		}
		return "created token\nbootstrap-token\n\n", nil
	}
	for _, ttl := range []string{"10m", "720h"} {
		if token, err := CreateBootstrapToken(ttl); err != nil || token != "bootstrap-token" {
			t.Fatal(token, err)
		}
	}
	for _, ttl := range []string{"9m", "721h", "bad", "-1h"} {
		if _, err := CreateBootstrapToken(ttl); err == nil {
			t.Fatal(ttl)
		}
	}
	runCreate = func(string) (string, error) { return "secret", errors.New("secret") }
	if _, err := CreateBootstrapToken("1h"); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal(err)
	}
	runCreate = func(string) (string, error) { return "", nil }
	if _, err := CreateBootstrapToken("1h"); err == nil {
		t.Fatal("empty output")
	}
	for _, role := range []Role{RoleServer, RoleAgent} {
		service, path := "k3s", ServerTokenFile
		if role == RoleAgent {
			service, path = "k3s-agent", AgentTokenFile
		}
		joinRestart = func(s string) error {
			if s != service {
				t.Fatal(s)
			}
			return nil
		}
		if err := InstallToken(role, "replacement"); err != nil {
			t.Fatal(err)
		}
		if data, _ := os.ReadFile(path); string(data) != "replacement\n" {
			t.Fatal(string(data))
		}
	}
	joinRestart = func(string) error { t.Fatal("unexpected restart"); return nil }
	if err := InstallToken(RoleServer, "bad token"); err == nil {
		t.Fatal("invalid token")
	}
}

func TestInstallExecThreading(t *testing.T) {
	a, b, c, d := installFromStack, installUpstream, installFromMirror, stackPaths
	t.Cleanup(func() { installFromStack, installUpstream, installFromMirror, stackPaths = a, b, c, d })
	stackPaths.Staging = t.TempDir()
	var calls []string
	installFromStack = func(exec string) error { calls = append(calls, "stack:"+exec); return errors.New("fallback") }
	installUpstream = func(exec string) error { calls = append(calls, "upstream:"+exec); return errors.New("fallback") }
	installFromMirror = func(exec string) error { calls = append(calls, "mirror:"+exec); return nil }
	for _, file := range []string{"k3s", "k3s-install.sh"} {
		if err := os.WriteFile(filepath.Join(stackPaths.Staging, file), []byte("x"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := installK3s("agent"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"stack:agent", "upstream:agent", "mirror:agent"}) {
		t.Fatal(calls)
	}
	if installExec("") != "" || installExec("agent") != "INSTALL_K3S_EXEC='agent' " {
		t.Fatal("install environment")
	}
}

// Joined servers must use the cluster's agent token, or k3s refuses to start
// on them after a restart ("cred/passwd newer than datastore", 3-node test).
func TestServerJoinTokenFileCarriesAgentToken(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "server.token")
	if err := WriteServerJoinTokenFile(p, "K10abc::server:s3cret", "K10abc::node:ag3nt"); err != nil {
		t.Fatal(err)
	}
	server, agent, err := ReadServerJoinTokens(p, nil)
	if err != nil || server != "K10abc::server:s3cret" || agent != "K10abc::node:ag3nt" {
		t.Fatalf("got %q %q %v", server, agent, err)
	}
	// Old single-line files keep working.
	if err := WriteServerJoinTokenFile(p, "K10abc::server:s3cret", ""); err != nil {
		t.Fatal(err)
	}
	if server, agent, err = ReadServerJoinTokens(p, nil); err != nil || server == "" || agent != "" {
		t.Fatalf("single line: %q %q %v", server, agent, err)
	}
	if _, _, err := ReadServerJoinTokens("-", strings.NewReader("a\nb\nc\n")); err == nil {
		t.Fatal("three lines must be rejected")
	}
}

func TestJoinServerWritesAgentTokenBeforeStart(t *testing.T) {
	tokenPaths(t)
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	t.Cleanup(func() { state.SetPath(state.DefaultPath) })
	a, b, c, d, e, f, g, h := joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig
	t.Cleanup(func() {
		joinWriteToken, joinWriteConfig, joinWriteRegistries, joinInstall, joinIsInstalled, joinRestart, joinWaitReady, joinSetupKubeconfig = a, b, c, d, e, f, g, h
	})
	var order []string
	joinWriteToken = func(p, tok string) error { order = append(order, p+"="+tok); return nil }
	joinWriteRegistries = func(string) (bool, error) { return false, nil }
	var cfgText string
	joinWriteConfig = func(content string, _ []string) (bool, error) { cfgText = content; order = append(order, "config"); return true, nil }
	joinIsInstalled = func() bool { return false }
	joinInstall = func(string) error { order = append(order, "install"); return nil }
	joinRestart = func(string) error { return nil }
	joinWaitReady = func() error { return nil }
	joinSetupKubeconfig = func() error { return nil }
	err := Join(RoleServer, "https://node:6443", "secret-token", "", ServerOptions{NodeIP: "10.0.0.2", AgentToken: "agent-token-1"})
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(order, " ")
	if !strings.Contains(joined, AgentTokenFile+"=agent-token-1") || strings.Index(joined, "agent-token-1") > strings.Index(joined, "install") {
		t.Fatalf("agent token must be written before k3s is installed: %s", joined)
	}
	if !strings.Contains(cfgText, "agent-token-file") || strings.Contains(cfgText, "agent-token-1") {
		t.Fatalf("config must reference the agent token file, never the token:\n%s", cfgText)
	}
}
