package cmd

import (
	"bytes"
	"errors"
	"io"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
)

func planNames(steps []joinStep) []string {
	var out []string
	for _, s := range steps {
		out = append(out, s.name)
	}
	return out
}

func TestJoinPlanPerRole(t *testing.T) {
	c := &config.Config{Profile: config.ProfileHA}
	if got, want := planNames(joinPlan(k3s.RoleAgent, c, nil)), []string{"longhorn-prereqs"}; !slices.Equal(got, want) {
		t.Fatalf("agent plan = %v, want %v (no server config on agents)", got, want)
	}
	if got, want := planNames(joinPlan(k3s.RoleServer, c, nil)), []string{"longhorn-prereqs", "local-storage-skip", "ingress-ha-config"}; !slices.Equal(got, want) {
		t.Fatalf("server plan = %v, want %v", got, want)
	}
}

// captureStdout runs fn with os.Stdout redirected and returns what it printed.
func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = w
	done := make(chan string)
	go func() {
		var b bytes.Buffer
		_, _ = io.Copy(&b, r)
		done <- b.String()
	}()
	runErr := fn()
	os.Stdout = old
	w.Close()
	return <-done, runErr
}

func TestRunJoinPreparesNodeBeforeK3s(t *testing.T) {
	for _, role := range []k3s.Role{k3s.RoleServer, k3s.RoleAgent} {
		t.Run(string(role), func(t *testing.T) {
			clusterTest(t)
			joinRole, joinServer, joinTokenFile, joinNodes = string(role), "https://10.0.0.60:6443", "-", "10.0.0.0/24"
			cfg.IngressHAMode, cfg.IngressVIP, cfg.APIVIP = config.IngressHAModeVIP, "10.0.0.50", "10.0.0.60"
			var calls []string
			joinPrepareLonghorn = func() error { calls = append(calls, "longhorn-prereqs"); return nil }
			joinStorageSkip = func() error { calls = append(calls, "local-storage-skip"); return nil }
			joinIngressFragment = func(c *config.Config) (bool, error) {
				if c.APIVIP != "10.0.0.60" || c.IngressHAMode != config.IngressHAModeVIP {
					t.Errorf("fragment rendered from %+v", c)
				}
				calls = append(calls, "ingress-ha-config")
				return true, nil
			}
			k3sJoin = func(r k3s.Role, url, token, gh string, o k3s.ServerOptions) error {
				calls = append(calls, "k3s")
				if url != "https://10.0.0.60:6443" {
					t.Errorf("join URL %s", url)
				}
				return nil
			}
			joinHarden = func() error { calls = append(calls, "harden"); return nil }
			env := map[string]string{}
			upsertEnvKey = func(path, k, v string) error { env[k] = v; return nil }

			out, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) })
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"longhorn-prereqs", "k3s", "harden"}
			if role == k3s.RoleServer {
				want = []string{"longhorn-prereqs", "local-storage-skip", "ingress-ha-config", "k3s", "harden"}
			}
			if !slices.Equal(calls, want) {
				t.Fatalf("calls = %v, want %v", calls, want)
			}
			if strings.Contains(out, "not-a-real-secret") {
				t.Fatal("join output leaks the token")
			}
			if !strings.Contains(out, "platformctl install longhorn") {
				t.Fatalf("missing Longhorn replica hint:\n%s", out)
			}
			if env["API_VIP"] != "10.0.0.60" || env["INGRESS_HA_MODE"] != "vip" {
				t.Fatalf("ingress HA settings not persisted: %v", env)
			}
			for k, v := range env {
				if strings.Contains(v, "not-a-real-secret") {
					t.Fatalf("token persisted in %s", k)
				}
			}
		})
	}
}

func TestRunJoinStopsWhenPreparationFails(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "agent", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
	joinPrepareLonghorn = func() error { return errors.New("Longhorn preflight: iscsid must be active") }
	k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error {
		t.Fatal("k3s must not start before the Longhorn prerequisites")
		return nil
	}
	_, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) })
	if err == nil || !strings.Contains(err.Error(), "longhorn-prereqs") || strings.Contains(err.Error(), "not-a-real-secret") {
		t.Fatalf("got %v", err)
	}
}

func TestRunJoinRestartsServerWhenFragmentChangedOnRerun(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "server", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
	joinK3sInstalled = func() bool { return true }
	joinIngressFragment = func(*config.Config) (bool, error) { return true, nil }
	restarted := false
	joinRestartServer = func() error { restarted = true; return nil }
	k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error { return nil }
	if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err != nil {
		t.Fatal(err)
	}
	if !restarted {
		t.Fatal("a changed config.yaml.d fragment on an installed server needs a k3s restart")
	}
}

func TestJoinViaAPIVIP(t *testing.T) {
	c := &config.Config{APIVIP: "10.0.0.60"}
	if !joinViaAPIVIP("10.0.0.60", c) || joinViaAPIVIP("10.0.0.11", c) || joinViaAPIVIP("10.0.0.60", &config.Config{}) {
		t.Fatal("API VIP detection")
	}
}
