package cmd

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/k3s"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/stack"
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

func TestJoinRefreshesBuildIsolation(t *testing.T) {
	for _, role := range []string{"server", "agent"} {
		for _, enabled := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/%t", role, enabled), func(t *testing.T) {
				clusterTest(t)
				joinRole, joinServer, joinTokenFile, joinNodes = role, "https://10.0.0.11:6443", "-", "10.0.0.0/24"
				t.Setenv("BUILDS_ENABLED", fmt.Sprint(enabled))
				cfg.BuildsEnabled, cfg.Profile = enabled, config.ProfileHA
				k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error { return nil }
				called := false
				joinBuildIsolation = func(*config.Config) error { called = true; return nil }
				out, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) })
				if err != nil {
					t.Fatal(err)
				}
				if called != (enabled && role == "server") {
					t.Fatal("incorrect build isolation refresh")
				}
				if enabled && role == "agent" && !strings.Contains(out, "BUILDS_EXTRA_BLOCKED_CIDRS") {
					t.Fatal("agent join must explain how to refresh isolation")
				}
			})
		}
	}
}

func TestJoinStagesBundleBeforePreparation(t *testing.T) {
	for _, role := range []string{"server", "agent"} {
		t.Run(role, func(t *testing.T) {
			clusterTest(t)
			joinRole, joinServer, joinTokenFile, joinNodes = role, "https://10.0.0.11:6443", "-", "10.0.0.0/24"
			joinBundle = "local.tar.zst"
			var calls []string
			joinStageBundle = func(path string) error {
				if path != joinBundle {
					t.Fatalf("bundle = %q", path)
				}
				calls = append(calls, "bundle")
				return nil
			}
			joinOfflinePackages = func() error { calls = append(calls, "packages"); return nil }
			joinPrepareLonghorn = func() error { calls = append(calls, "prereqs"); return nil }
			k3sJoin = func(_ k3s.Role, _, _, _ string, o k3s.ServerOptions) error {
				if !o.Offline {
					t.Fatal("bundle join must disable installer downloads")
				}
				calls = append(calls, "k3s")
				return nil
			}
			if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(calls, []string{"bundle", "packages", "prereqs", "k3s"}) {
				t.Fatal(calls)
			}
		})
	}
}

func TestOnlineJoinSkipsOfflinePackages(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "agent", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
	joinOfflinePackages = func() error { t.Fatal("offline packages without --bundle"); return nil }
	k3sJoin = func(_ k3s.Role, _, _, _ string, o k3s.ServerOptions) error {
		if o.Offline {
			t.Fatal("online join must keep the download fallback")
		}
		return nil
	}
	if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err != nil {
		t.Fatal(err)
	}
}

func TestJoinOfflinePackageFailureStopsBeforeK3s(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "server", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
	joinBundle = "local.tar.zst"
	joinOfflinePackages = func() error { return errors.New("bundle has no packages for ubuntu 26.04") }
	k3sJoin = func(k3s.Role, string, string, string, k3s.ServerOptions) error {
		t.Fatal("k3s after failed packages")
		return nil
	}
	if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err == nil || !strings.Contains(err.Error(), "offline-packages") {
		t.Fatal(err)
	}
}

// fakeJoinBundle swaps the bundle installer for one that stages files under
// a temporary stack directory.
func fakeJoinBundle(t *testing.T, files ...string) stack.Paths {
	t.Helper()
	root := t.TempDir()
	paths := stack.Paths{Staging: filepath.Join(root, "stack"), K3sImages: filepath.Join(root, "images")}
	oldPaths, oldInstall := joinStackPaths, joinInstallBundle
	t.Cleanup(func() { joinStackPaths, joinInstallBundle = oldPaths, oldInstall })
	joinStackPaths = paths
	joinInstallBundle = func(string) error {
		for _, f := range files {
			p := filepath.Join(paths.Staging, filepath.FromSlash(f))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(p, []byte(f), 0o644); err != nil {
				return err
			}
		}
		return nil
	}
	return paths
}

func TestPrepareJoinBundle(t *testing.T) {
	arch := runtime.GOARCH
	other := "arm64"
	if arch == "arm64" {
		other = "amd64"
	}
	for _, tc := range []struct {
		name    string
		files   []string
		wantErr string
	}{
		{"complete", []string{"k3s", "k3s-install.sh", "packages/ubuntu-22.04/" + arch + "/Packages"}, ""},
		{"no k3s", []string{"packages/ubuntu-22.04/" + arch + "/Packages"}, "lacks the k3s binary"},
		{"no packages", []string{"k3s", "k3s-install.sh"}, "no node packages for " + arch},
		{"other architecture", []string{"k3s", "k3s-install.sh", "packages/ubuntu-24.04/" + other + "/Packages"}, "no node packages for " + arch},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fakeJoinBundle(t, tc.files...)
			t.Setenv("PLATFORM_STACK", "")
			err := prepareJoinBundle("bundle.tar.zst")
			if tc.wantErr == "" && err != nil || tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestPrepareJoinBundleInstallFailure(t *testing.T) {
	fakeJoinBundle(t)
	joinInstallBundle = func(string) error { return errors.New("bundle: checksum mismatch for k3s/k3s") }
	if err := prepareJoinBundle("bundle.tar.zst"); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatal(err)
	}
}

func TestJoinBundleFailureStopsPreparation(t *testing.T) {
	clusterTest(t)
	joinRole, joinServer, joinTokenFile, joinNodes = "agent", "https://10.0.0.11:6443", "-", "10.0.0.0/24"
	joinStageBundle = func(string) error { return errors.New("invalid bundle") }
	joinPrepareLonghorn = func() error { t.Fatal("prereqs after failed bundle"); return nil }
	if _, err := captureStdout(t, func() error { return runJoin(strings.NewReader(testToken)) }); err == nil || !strings.Contains(err.Error(), "invalid bundle") {
		t.Fatal(err)
	}
}

func TestJoinStagesStackImagesBeforeStartup(t *testing.T) {
	root := t.TempDir()
	paths := stack.Paths{Staging: filepath.Join(root, "stack"), K3sImages: filepath.Join(root, "agent", "images")}
	if err := os.MkdirAll(paths.ImagesDir(), 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"platform.tar.zst", "kube-vip.tar"} {
		if err := os.WriteFile(filepath.Join(paths.ImagesDir(), name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := stageJoinImages(paths); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"platform.tar.zst", "kube-vip.tar"} {
		data, err := os.ReadFile(filepath.Join(paths.K3sImages, name))
		if err != nil || string(data) != name {
			t.Fatalf("image %s: %s %v", name, data, err)
		}
	}
}

func TestJoinStackOffDoesNotDownload(t *testing.T) {
	t.Setenv("PLATFORM_STACK", "off")
	if err := prepareJoinBundle(""); err != nil {
		t.Fatal(err)
	}
}
