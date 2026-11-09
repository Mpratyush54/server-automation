package components

import (
	"errors"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestUpgradeResolverDoesNotMutateAndQuotesImages(t *testing.T) {
	script := digestTestTools + `API='ghcr.io/test/platform-api:1.2.3'
PORTAL='ghcr.io/test/platform-portal:1.2.3'
` + upgradeResolveScript() + `[[ $rolls == 0 ]] || exit 90
[[ ! -s "$MIG_FILE" ]] || exit 91
`
	if out, e := runJobShell(t, script); e != nil {
		t.Fatalf("%v: %s", e, out)
	}
	script = digestTestTools + `API='ghcr.io/test/api:1.2.3'
PORTAL='ghcr.io/test/portal:1.2.3'
DIGEST=invalid
ALLOW_LOCAL_IMAGES=true
` + upgradeResolveScript()
	if out, e := runJobShell(t, script); e != nil {
		t.Fatalf("local fallback: %v: %s", e, out)
	}
}

func TestLocalUpgradeRestoreStreamsPasswordAndQuotedDump(t *testing.T) {
	dump := filepath.Join(t.TempDir(), "platform ' dollar $ dump.dump")
	if e := os.WriteFile(dump, []byte("archive-fixture"), 0600); e != nil {
		t.Fatal(e)
	}
	script := `kubectl(){
 if [[ "$*" == *" get pod "* ]]; then printf postgresql-0; return; fi
 [[ "$*" == *"pg_restore -w -U postgres -d template1 --clean --if-exists --create --exit-on-error"* ]] || return 91
 [[ "$*" != *"fixture-password"* ]] || return 92
 local password body
 IFS= read -r password
 body="$(cat)"
 [[ "$password" == 'fixture-password' && "$body" == 'archive-fixture' ]] || return 93
}
DUMP=` + shellQuote(filepath.ToSlash(dump)) + `
PGPW=fixture-password
` + upgradeRestoreScript
	if out, e := runJobShell(t, script); e != nil {
		t.Fatalf("%v: %s", e, out)
	}
}

func TestIndependentUpdateSchedules(t *testing.T) {
	oldApply, oldBash, oldMark := autoUpdateApply, autoUpdateRunBash, autoUpdateMarkDone
	t.Cleanup(func() { autoUpdateApply, autoUpdateRunBash, autoUpdateMarkDone = oldApply, oldBash, oldMark })
	for _, digest := range []bool{false, true} {
		for _, release := range []bool{false, true} {
			var got []string
			bashCalls, marks := 0, 0
			autoUpdateRunBash = func(string) error { bashCalls++; return nil }
			autoUpdateMarkDone = func(string) error { marks++; return nil }
			autoUpdateApply = func(name string, args []string, body string) (string, error) {
				if name != "kubectl" || !reflect.DeepEqual(args, []string{"apply", "-f", "-"}) {
					t.Fatalf("unexpected command %s %q", name, args)
				}
				if strings.Contains(body, "name: platform-auto-upgrade") {
					got = append(got, "release")
				} else {
					got = append(got, "digest")
					if !strings.Contains(body, "ghcr.io/test/platform-api:1.2.3") || strings.Contains(body, "{{API_IMAGE}}") {
						t.Fatal("images not substituted")
					}
				}
				return "", nil
			}
			var want []string
			if digest {
				want = append(want, "digest")
			}
			if release {
				want = append(want, "release")
			}
			if err := InstallAutoUpdate(&config.Config{AutoUpdate: digest, AutoUpgrade: release, ImageRegistry: "ghcr.io/test", ImageTag: "1.2.3"}); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("flags %v/%v: got %v want %v", digest, release, got, want)
			}
			if (bashCalls == 1) != digest || (marks == 1) != digest {
				t.Fatalf("digest side effects: bash=%d marks=%d", bashCalls, marks)
			}
		}
	}
	autoUpdateApply = func(string, []string, string) (string, error) { return "", errors.New("apply failed") }
	if err := InstallAutoUpdate(&config.Config{AutoUpgrade: true}); err == nil {
		t.Fatal("lost apply failure")
	}
}

func TestReleaseUpgradeManifest(t *testing.T) {
	body := readManifest("auto-upgrade-cronjob.yaml")
	for _, want := range []string{"name: platform-auto-upgrade", `schedule: "20 4 * * *"`, `timeZone: "Etc/UTC"`, "concurrencyPolicy: Forbid", "hostPID: true", "privileged: true", "runAsUser: 0", `"nsenter", "-t", "1", "-m", "-u", "-i", "-n", "--root", "--wd", "--", "/usr/local/bin/platformctl", "upgrade", "--patch-only", "--yes"`, "automountServiceAccountToken: false"} {
		if !strings.Contains(body, want) {
			t.Fatalf("release manifest missing %s", want)
		}
	}
	if strings.Contains(body, "platform-auto-update") || strings.Contains(body, "TOKEN") {
		t.Fatal("release job must be separate and token-free")
	}
	digest := readManifest("auto-update-cronjob.yaml")
	for _, want := range []string{"name: platform-auto-update", "ALLOW_LOCAL_IMAGES", "resolve_image"} {
		if !strings.Contains(digest, want) {
			t.Fatalf("digest manifest missing %s", want)
		}
	}
}
