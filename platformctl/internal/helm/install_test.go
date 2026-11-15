package helm

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/state"
)

func withInstallStubs(t *testing.T, present bool) *[]string {
	t.Helper()
	state.SetPath(filepath.Join(t.TempDir(), "state"))
	oldPresent, oldRun := pinnedHelmPresent, installRunBash
	t.Cleanup(func() {
		pinnedHelmPresent, installRunBash = oldPresent, oldRun
		state.SetPath(state.DefaultPath)
	})
	var scripts []string
	pinnedHelmPresent = func() bool { return present }
	installRunBash = func(s string) error { scripts = append(scripts, s); return nil }
	return &scripts
}

// `provision --bundle` installs the bundle's Helm binary: no get.helm.sh.
func TestInstallFromBundleSkipsDownload(t *testing.T) {
	scripts := withInstallStubs(t, false)
	if err := InstallFrom("/var/lib/platform/stack/helm"); err != nil {
		t.Fatal(err)
	}
	if len(*scripts) != 1 {
		t.Fatalf("scripts = %q", *scripts)
	}
	s := (*scripts)[0]
	if !strings.Contains(s, "install -m 0755 '/var/lib/platform/stack/helm' /usr/local/bin/helm") {
		t.Fatalf("script does not install the bundled binary:\n%s", s)
	}
	if strings.Contains(s, "get.helm.sh") || strings.Contains(s, "curl") {
		t.Fatalf("bundle install downloads:\n%s", s)
	}
	if !state.IsDone("helm") {
		t.Fatal("helm not marked done")
	}
}

func TestInstallFromBundleKeepsPinnedHelm(t *testing.T) {
	scripts := withInstallStubs(t, true)
	if err := InstallFrom("/x/helm"); err != nil || len(*scripts) != 0 {
		t.Fatalf("err=%v scripts=%q", err, *scripts)
	}
}
