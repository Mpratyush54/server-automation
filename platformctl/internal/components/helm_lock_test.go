package components

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A provision killed mid-step leaves every release it was installing
// pending-install (seen on a real cluster: argocd, cert-manager and
// ingress-nginx at once). Every helm install must clear that first.

func TestHelmLockClearQuotesReleaseAndNamespace(t *testing.T) {
	s := helmLockClear("cert-manager", "cert-manager")
	for _, want := range []string{"clear_helm_lock() {", "kubectl get namespace 'cert-manager'", "clear_helm_lock 'cert-manager' 'cert-manager'"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in:\n%s", want, s)
		}
	}
	if strings.Contains(helmLockClear("x'y", "ns"), "x'y'") {
		t.Fatal("release name not shell-quoted")
	}
}

func TestScriptedHelmInstallsClearTheLockFirst(t *testing.T) {
	cases := map[string]string{
		"cert-manager":    certManagerInstallScript(),
		"tempo":           telemetryHelmScript("tempo", "/tmp/values.yaml"),
		"loki":            monitoringLockClear() + "helm upgrade --install loki",
		"kube-prometheus": monitoringLockClear() + "helm upgrade --install kube-prometheus",
	}
	for release, script := range cases {
		clear := strings.Index(script, "clear_helm_lock '"+release+"'")
		install := strings.Index(script, "helm upgrade --install "+release)
		if clear < 0 || install < 0 || clear > install {
			t.Errorf("%s: lock clear (%d) must come before the install (%d)", release, clear, install)
		}
	}
}

// Runs the real snippet against a fake kubectl: only pending-* release
// secrets are deleted, deployed history is kept.
func TestHelmLockClearDeletesOnlyPendingReleaseSecrets(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("needs bash")
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	fake := `#!/bin/sh
case "$*" in
  "get namespace"*) exit 0 ;;
  *"get secrets"*) printf 'sh.helm.release.v1.cm.v1\tdeployed\nsh.helm.release.v1.cm.v2\tpending-install\nsh.helm.release.v1.cm.v3\tpending-upgrade\n' ;;
  *"delete secret"*) echo "$*" >> "` + log + `" ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(fake), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("bash", "-c", "set -euo pipefail\n"+helmLockClear("cm", "cert-manager"))
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("snippet failed: %v\n%s", err, out)
	}
	data, _ := os.ReadFile(log)
	got := string(data)
	if !strings.Contains(got, "sh.helm.release.v1.cm.v2") || !strings.Contains(got, "sh.helm.release.v1.cm.v3") {
		t.Errorf("pending release secrets not deleted:\n%s", got)
	}
	if strings.Contains(got, "sh.helm.release.v1.cm.v1") {
		t.Errorf("deployed release secret deleted:\n%s", got)
	}
}

func TestHelmValuesClearsTheLockBeforeHelm(t *testing.T) {
	var calls []string
	old := clearStuckHelmRelease
	clearStuckHelmRelease = func(release, ns string) { calls = append(calls, release+"/"+ns) }
	defer func() { clearStuckHelmRelease = old }()
	t.Setenv("PATH", t.TempDir()) // no helm: the install itself fails fast
	_ = helmValues("ingress-nginx", "ingress-nginx", "ingress-nginx", map[string]any{"controller": map[string]any{}})
	if len(calls) != 1 || calls[0] != "ingress-nginx/ingress-nginx" {
		t.Fatalf("lock clear calls = %v, want [ingress-nginx/ingress-nginx]", calls)
	}
}

func TestKEDAReleaseNameIsTheThirdHelmArg(t *testing.T) {
	for http, want := range map[bool]string{false: "keda", true: "keda-add-ons-http"} {
		if got := kedaInstallArgs(http)[2]; got != want {
			t.Errorf("kedaInstallArgs(%v)[2] = %q, want %q", http, got, want)
		}
	}
}
