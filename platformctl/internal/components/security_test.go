package components

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

type toolCall struct {
	Tool  string
	Args  []string
	Input string
	Files []string
}

// A copy of the test binary acts as each external tool, recording data before
// private files are removed. No cluster or root access is used by these tests.
func init() {
	if os.Getenv("PLATFORMCTL_FAKE_TOOLS") != "1" {
		return
	}
	tool := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	if tool != "helm" && tool != "kubectl" && tool != "bash" {
		return
	}
	call := toolCall{Tool: tool, Args: os.Args[1:]}
	if tool == "kubectl" && strings.Join(call.Args, " ") == "apply -f -" {
		b, _ := io.ReadAll(os.Stdin)
		call.Input = string(b)
	}
	if tool == "helm" {
		for i, arg := range call.Args {
			if arg == "-f" && i+1 < len(call.Args) {
				b, _ := os.ReadFile(call.Args[i+1])
				call.Files = append(call.Files, string(b))
			}
		}
	}
	if tool == "bash" {
		for _, match := range regexp.MustCompile(`'([^']*platformctl-private-[^']*)'`).FindAllStringSubmatch(strings.Join(call.Args, " "), -1) {
			b, err := os.ReadFile(match[1])
			if err == nil {
				call.Files = append(call.Files, string(b))
			}
		}
	}
	b, _ := json.Marshal(call)
	f, err := os.OpenFile(os.Getenv("PLATFORMCTL_TOOL_LOG"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		os.Exit(99)
	}
	f.Write(append(b, '\n'))
	f.Close()
	mode := os.Getenv("PLATFORMCTL_TOOL_FAILURE")
	if mode == "apply" && tool == "kubectl" {
		os.Exit(7)
	}
	if mode == "ready" && tool == "bash" && strings.Contains(strings.Join(call.Args, " "), "kubectl wait") {
		os.Exit(8)
	}
	if mode == "login" && tool == "bash" && strings.Contains(strings.Join(call.Args, " "), "TOKEN=") {
		os.Exit(9)
	}
	os.Exit(0)
}

func fakeTools(t *testing.T) func() []toolCall {
	t.Helper()
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(exe)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range []string{"helm", "kubectl", "bash"} {
		name := tool
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	log := filepath.Join(dir, "calls.jsonl")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PLATFORMCTL_FAKE_TOOLS", "1")
	t.Setenv("PLATFORMCTL_TOOL_LOG", log)
	state.SetPath(filepath.Join(dir, "state"))
	t.Cleanup(func() { state.SetPath(state.DefaultPath) })
	return func() []toolCall {
		data, _ := os.ReadFile(log)
		var out []toolCall
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if line == "" {
				continue
			}
			var c toolCall
			if err := json.Unmarshal([]byte(line), &c); err != nil {
				t.Fatal(err)
			}
			out = append(out, c)
		}
		return out
	}
}

func TestInstallDatastoreSecretsAreLiteralValues(t *testing.T) {
	for _, name := range []string{"postgresql", "mongodb", "redis", "minio", "monitoring"} {
		t.Run(name, func(t *testing.T) {
			calls := fakeTools(t)
			// Includes command substitution, quoting, Helm comma syntax and a newline.
			secret := "space $(touch /tmp/injected) '" + "\"" + ",false=true\nsecond line"
			cfg := &config.Config{PostgresPassword: secret, MongoPassword: secret, RedisPassword: secret, MinioSecretKey: secret, MinioAccessKey: "admin", GrafanaPassword: secret}
			if err := Find(name).Install(cfg); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, c := range calls() {
				if c.Tool == "helm" {
					for _, arg := range c.Args {
						if strings.Contains(arg, " --version ") {
							t.Fatal("chart options combined into a single argument")
						}
					}
				}
				if strings.Contains(strings.Join(c.Args, " "), secret) {
					t.Fatal("secret leaked into executable arguments/shell source")
				}
				for _, f := range c.Files {
					var values map[string]any
					if json.Unmarshal([]byte(f), &values) == nil {
						auth, _ := values["auth"].(map[string]any)
						if name == "monitoring" {
							auth, _ = values["grafana"].(map[string]any)
						}
						for _, v := range auth {
							if v == secret {
								found = true
							}
						}
					}
				}
			}
			if !found {
				t.Fatal("Helm did not receive the exact password through a values file")
			}
		})
	}
}

func TestPlatformSecretAndWorkloadIsolation(t *testing.T) {
	calls := fakeTools(t)
	cfg := &config.Config{MongoPassword: "$(touch /tmp/injected)", JWTSecret: strings.Repeat("j", 32), SecretsEncryptionKey: strings.Repeat("a", 64), AdminPassword: "operator password"}
	if err := InstallPlatform(cfg); err != nil {
		t.Fatal(err)
	}
	var script string
	foundSecret := false
	for _, c := range calls() {
		if c.Tool == "bash" {
			script += strings.Join(c.Args, " ")
		}
		if c.Input != "" {
			var secret struct {
				Kind       string
				StringData map[string]string
			}
			if json.Unmarshal([]byte(c.Input), &secret) == nil && secret.Kind == "Secret" {
				foundSecret = true
				if secret.StringData["SECRETS_ENCRYPTION_KEY"] != cfg.SecretsEncryptionKey || secret.StringData["ADMIN_PASSWORD"] != cfg.AdminPassword {
					t.Fatal("required secret missing")
				}
			}
		}
	}
	if !foundSecret {
		t.Fatal("platform-env not applied as structured input")
	}
	if strings.Contains(script, cfg.MongoPassword) {
		t.Fatal("Mongo password interpolated into shell")
	}
	for _, s := range []string{"set -euo pipefail", "serviceAccountName: platform-api", "automountServiceAccountToken: false", "runAsNonRoot: true", "allowPrivilegeEscalation: false", "drop: [\"ALL\"]", "containerPort: 8080", "targetPort: 8080"} {
		if !strings.Contains(script, s) {
			t.Errorf("missing workload protection %s", s)
		}
	}
	if strings.Contains(script, "name: cluster-admin") || strings.Contains(script, "--timeout=300s || true") || strings.Contains(script, "--timeout=180s || true") {
		t.Fatal("unsafe grant or ignored readiness failure")
	}
}

func TestPlatformFailuresDoNotMarkDone(t *testing.T) {
	for _, mode := range []string{"apply", "ready"} {
		t.Run(mode, func(t *testing.T) {
			fakeTools(t)
			t.Setenv("PLATFORMCTL_TOOL_FAILURE", mode)
			if err := InstallPlatform(&config.Config{}); err == nil {
				t.Fatal("expected deployment failure")
			}
			if state.IsDone("platform") {
				t.Fatal("failed deployment recorded as complete")
			}
		})
	}
}

func TestPortainerLoginFailureNeverDeletesData(t *testing.T) {
	calls := fakeTools(t)
	t.Setenv("PLATFORMCTL_TOOL_FAILURE", "login")
	if err := ensurePortainerAdminAndSSO(&config.Config{Domain: "example.test", WebhookSecret: "private-oauth-value"}, "private-login-password"); err == nil {
		t.Fatal("expected auth error")
	}
	for _, c := range calls() {
		script := strings.Join(c.Args, " ")
		if strings.Contains(script, "delete pvc") || strings.Contains(script, "delete namespace") {
			t.Fatal("authentication failure can delete storage")
		}
		if !strings.Contains(script, "platformctl install portainer --reset") {
			t.Fatal("missing explicit reset advice")
		}
		for _, secret := range []string{"private-login-password", "private-oauth-value"} {
			if strings.Contains(script, secret) {
				t.Fatal("secret in shell source")
			}
		}
	}
}

func TestPrivateValuesFilePermissionsAndCleanup(t *testing.T) {
	path, cleanup, err := privateJSON(map[string]string{"password": "test-only"})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("mode=%o", info.Mode().Perm())
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("temporary secret retained")
	}
}

func TestPortainerStorageResetIsExplicit(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(fmt.Sprint(reset), func(t *testing.T) {
			calls := fakeTools(t)
			t.Setenv("PLATFORMCTL_TOOL_FAILURE", "login")
			cfg := &config.Config{Domain: "example.test", PortainerPassword: "test-only-password", ResetPortainer: reset}
			if err := InstallPortainer(cfg); err == nil {
				t.Fatal("authentication failure was ignored")
			}
			deleted := false
			for _, c := range calls() {
				args := strings.Join(c.Args, " ")
				if strings.Contains(args, "delete namespace") {
					t.Fatal("Helm retry can remove persistent storage")
				}
				if strings.Contains(args, "delete pvc") {
					deleted = true
				}
			}
			if deleted != reset {
				t.Fatalf("PVC deletion=%v explicit reset=%v", deleted, reset)
			}
		})
	}
}
