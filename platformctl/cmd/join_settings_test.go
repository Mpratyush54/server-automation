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
)

// clusterSettingsFile writes the join settings a first server in vip mode
// would hand out and returns the file path.
func clusterSettingsFile(t *testing.T) string {
	t.Helper()
	first := &config.Config{
		Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP,
		IngressVIP: "10.0.0.50", APIVIP: "10.0.0.60",
	}
	path := filepath.Join(t.TempDir(), "join-settings")
	var stderr bytes.Buffer
	if err := writeJoinSettings(&stderr, first, path); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWriteJoinSettingsHoldsNoSecret(t *testing.T) {
	c := &config.Config{
		Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeVIP, IngressVIP: "10.0.0.50",
		GitHubToken: "ghp_" + "not-a-real-secret",
	}
	path := filepath.Join(t.TempDir(), "s")
	var stderr bytes.Buffer
	if err := writeJoinSettings(&stderr, c, path); err != nil {
		t.Fatal(err)
	}
	body, _ := os.ReadFile(path)
	for _, out := range []string{string(body), stderr.String()} {
		if strings.Contains(out, "not-a-real-secret") || strings.Contains(out, "K10") {
			t.Fatalf("join settings output carries a secret:\n%s", out)
		}
	}
	if !strings.Contains(string(body), "INGRESS_HA_MODE=vip\nINGRESS_VIP=10.0.0.50\n") {
		t.Fatalf("settings body:\n%s", body)
	}
	// Without a file the block goes to stderr only.
	stderr.Reset()
	if err := writeJoinSettings(&stderr, c, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stderr.String(), "INGRESS_VIP=10.0.0.50") {
		t.Fatalf("stderr: %s", stderr.String())
	}
}

func TestRunJoinServerRefusesMismatchedIngressSettings(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "server", "https://10.0.0.60:6443", "-", "10.0.0.0/24"
	joinSettingsFile = clusterSettingsFile(t)
	// This node would run external mode: k3s keeps ServiceLB on and refuses it.
	cfg.IngressHAMode = config.IngressHAModeExternal
	touched := errors.New("host changed before the settings check")
	joinPrepareLonghorn = func() error { return touched }
	k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error { return touched }
	upsertEnvKey = func(string, string, string) error { return touched }
	err := runJoin(strings.NewReader(testToken))
	if err == nil || errors.Is(err, touched) || !strings.Contains(err.Error(), "INGRESS_HA_MODE: cluster \"vip\", this node \"external\"") {
		t.Fatalf("want mismatch refusal before host changes, got %v", err)
	}
	if strings.Contains(err.Error(), "not-a-real-secret") {
		t.Fatal("error leaks the token")
	}

	// Same mode, different VIP.
	joinIngressHAMode, joinIngressVIP, joinAPIVIP = "vip", "10.0.0.51", "10.0.0.60"
	err = runJoin(strings.NewReader(testToken))
	if err == nil || errors.Is(err, touched) || !strings.Contains(err.Error(), "INGRESS_VIP: cluster \"10.0.0.50\", this node \"10.0.0.51\"") {
		t.Fatalf("want VIP mismatch refusal, got %v", err)
	}
}

func TestRunJoinServerAcceptsMatchingIngressSettings(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "server", "https://10.0.0.60:6443", "-", "10.0.0.0/24"
	joinSettingsFile = clusterSettingsFile(t)
	// Flags override the (external) environment; mode follows from the VIP.
	joinIngressVIP, joinAPIVIP = "10.0.0.50", "10.0.0.60"
	var rendered *config.Config
	joinIngressFragment = func(c *config.Config) (bool, error) { rendered = c; return true, nil }
	joined := false
	k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error { joined = true; return nil }
	env := map[string]string{}
	upsertEnvKey = func(_, k, v string) error { env[k] = v; return nil }
	if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err != nil {
		t.Fatal(err)
	}
	if !joined || rendered == nil || rendered.IngressHAMode != config.IngressHAModeVIP || rendered.IngressVIP != "10.0.0.50" {
		t.Fatalf("joined=%v rendered=%+v", joined, rendered)
	}
	if env["INGRESS_HA_MODE"] != "vip" || env["INGRESS_VIP"] != "10.0.0.50" || env["API_VIP"] != "10.0.0.60" {
		t.Fatalf("persisted ingress settings: %v", env)
	}
}

func TestRunJoinAgentIgnoresIngressSettings(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "agent", "https://10.0.0.60:6443", "-", "10.0.0.0/24"
	joinSettingsFile = clusterSettingsFile(t) // vip; this node's env says external
	joinIngressFragment = func(*config.Config) (bool, error) {
		t.Fatal("agents write no ingress HA config")
		return false, nil
	}
	joined := false
	k3sJoin = func(r k3s.Role, _, _, _ string, _ k3s.ServerOptions) error { joined = r == k3s.RoleAgent; return nil }
	if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err != nil {
		t.Fatal(err)
	}
	if !joined {
		t.Fatal("agent did not join")
	}
}

func TestCheckJoinIngressSettingsInputs(t *testing.T) {
	c := &config.Config{Profile: config.ProfileHA, IngressHAMode: config.IngressHAModeExternal}
	var warn bytes.Buffer
	if err := checkJoinIngressSettings(c, "", &warn); err != nil || !strings.Contains(warn.String(), "no --join-settings") {
		t.Fatalf("no file: err=%v warn=%q", err, warn.String())
	}
	if err := checkJoinIngressSettings(c, "-", &warn); err == nil {
		t.Fatal("stdin accepted for settings (reserved for the token)")
	}
	tokenFile := filepath.Join(t.TempDir(), "server.token")
	_ = os.WriteFile(tokenFile, []byte(testToken+"\n"), 0o600)
	err := checkJoinIngressSettings(c, tokenFile, &warn)
	if err == nil || strings.Contains(err.Error(), "not-a-real-secret") {
		t.Fatalf("token file passed as settings: %v", err)
	}
	bad := &config.Config{Profile: config.ProfileHA, IngressHAMode: "loadbalancer"}
	if err := checkJoinIngressSettings(bad, "", &warn); err == nil {
		t.Fatal("invalid mode accepted")
	}
}
