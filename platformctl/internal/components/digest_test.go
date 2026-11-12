package components

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Simulate registry replies and count pod-template image changes.
const digestTestTools = `DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
rolls=0
declare -A current=()
curl() {
 if [[ "$*" == *"--get"* ]]; then printf '{"token":"test-token"}'; return; fi
 if [[ "$*" == *"-sSI"* ]]; then printf 'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm="https://ghcr.io/token",service="ghcr.io"\r\n'; return; fi
 printf 'HTTP/1.1 200 OK\r\nDocker-Content-Digest: %s\r\n' "$DIGEST"
}
jq() { cat >/dev/null; printf test-token; }
MIG_FILE="$(mktemp)"
sleep() { :; }
sha256sum() { cat >/dev/null; echo "0123456789abcdef0123456789abcdef  -"; }
kubectl() {
 if [[ "$*" == "-n platform get configmap "* ]]; then printf 'kind: Job\nmetadata:\n  name: __NAME__\n'; return; fi
 if [[ "$*" == "-n platform get job "* ]]; then
  if [[ "$*" == *"{.status.succeeded}/{.status.failed}"* ]]; then
   if [[ "${FAIL_MIGRATION:-0}" == 1 ]]; then printf '/1'; else printf '1/'; fi
  fi
  return 0
 fi
 if [[ "$*" == "-n platform delete "* || "$*" == "-n platform logs "* ]]; then return 0; fi
 if [[ "$*" == "apply -f -" ]]; then cat >/dev/null; echo applied >> "$MIG_FILE"; return 0; fi
 if [[ "$1 $2" == "set image" ]]; then
  [[ -s "$MIG_FILE" ]] || { echo "API rolled before migrations" >&2; return 96; }
  [[ "$DIGEST" != invalid ]] || { echo "mutated with invalid digest" >&2; return 99; }
  local deployment="$5" image="$6"
  [[ "$image" == *@sha256:* ]] || return 98
  if [[ "${current[$deployment]:-}" != "$image" ]]; then current[$deployment]="$image"; rolls=$((rolls+1)); fi
 elif [[ "$1 $2" == "rollout status" ]]; then
  [[ "${FAIL_ROLLOUT:-0}" != 1 ]] || return 7
 else
  echo "unexpected Kubernetes mutation: $*" >&2; return 97
 fi
}
`

func runJobShell(t *testing.T, script string) (string, error) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash unavailable")
	}
	// Run from a file: long multi-copy scripts passed via argv get mangled by
	// the Windows (MSYS) command-line round trip.
	path := filepath.Join(t.TempDir(), "job.sh")
	if err := os.WriteFile(path, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(bash, filepath.ToSlash(path)).CombinedOutput()
	return string(out), err
}
func TestDigestUpdateOnlyRollsForChangedDigest(t *testing.T) {
	reset := "\nAPI=ghcr.io/test/platform-api:latest\nPORTAL=ghcr.io/test/platform-portal:latest\n"
	script := digestTestTools + reset + digestUpdateScript + reset + digestUpdateScript + "\n[[ $rolls == 2 ]] || exit 90\nDIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" + reset + digestUpdateScript + "\n[[ $rolls == 4 ]] || exit 91\n"
	if out, err := runJobShell(t, script); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}
func TestDigestUpdateRejectsInvalidDigestAndRolloutFailure(t *testing.T) {
	for _, setup := range []string{"DIGEST=invalid", "FAIL_ROLLOUT=1", "FAIL_MIGRATION=1"} {
		script := digestTestTools + "\n" + setup + "\nAPI=ghcr.io/test/platform-api:latest\nPORTAL=ghcr.io/test/platform-portal:latest\n" + digestUpdateScript
		if out, err := runJobShell(t, script); err == nil {
			t.Fatalf("job ignored %s: %s", setup, out)
		}
	}
}

// Offline/bundle installs: no registry digest, but the images are already on
// the node. With ALLOW_LOCAL_IMAGES the tag is used as-is (migrations still run
// first); without it the update must refuse, so online auto-update stays pinned.
func TestDigestUpdateFallsBackToLocalImagesOnlyWhenAllowed(t *testing.T) {
	wrap := `
eval "$(declare -f kubectl | sed '1s/^kubectl/orig_kubectl/')"
SET_FILE="$(mktemp)"
kubectl() {
 if [[ "$1 $2" == "set image" ]]; then
  [[ -s "$MIG_FILE" ]] || { echo "API rolled before migrations" >&2; return 96; }
  echo "$6" >> "$SET_FILE"; return 0
 fi
 orig_kubectl "$@"
}
API=ghcr.io/test/platform-api:offline
PORTAL=ghcr.io/test/platform-portal:offline
`
	check := `
grep -qx 'api=ghcr.io/test/platform-api:offline' "$SET_FILE" || { cat "$SET_FILE"; exit 80; }
grep -qx 'portal=ghcr.io/test/platform-portal:offline' "$SET_FILE" || exit 81
`
	for name, setup := range map[string]string{
		"registry has no digest": "DIGEST=invalid",
		"registry unreachable":   "curl() { return 6; }",
	} {
		allowed := digestTestTools + "\n" + setup + "\nALLOW_LOCAL_IMAGES=true\n" + wrap + digestUpdateScript + check
		if out, err := runJobShell(t, allowed); err != nil {
			t.Fatalf("%s with ALLOW_LOCAL_IMAGES: %v %s", name, err, out)
		}
		strict := digestTestTools + "\n" + setup + "\n" + wrap + digestUpdateScript
		if out, err := runJobShell(t, strict); err == nil {
			t.Fatalf("%s without ALLOW_LOCAL_IMAGES must refuse: %s", name, out)
		}
	}
}

func TestRecoveryAdminSQLAlwaysAuthenticatesAndPropagatesFailure(t *testing.T) {
	start := strings.Index(recoverScript, "kubectl -n databases exec -i \"$PG_POD\" -c \"$PG_CONTAINER\" -- bash -lc 'cat > \"${TMPDIR:-/tmp}/platformctl-recover-admin.sql\"'")
	if start < 0 {
		t.Fatal("admin recovery step missing")
	}
	end := strings.Index(recoverScript[start:], "if [[ -n \"$RD_PASS\" ]]") + start
	if end < start {
		t.Fatal("admin recovery boundary missing")
	}
	segment := recoverScript[start:end]
	for _, trust := range []string{"0", "1"} {
		for _, fail := range []bool{false, true} {
			status := "0"
			if fail {
				status = "12"
			}
			prefix := "set -euo pipefail\nWORKING=known-working\nPG_POD=postgresql-0\nPG_CONTAINER=postgresql\nSQL_FILE=/dev/null\nUSED_TRUST=" + trust + "\nkubectl() { return 0; }\npsql_with_pw() { [[ $1 == known-working && $2 == platform ]] || return 99; return " + status + "; }\n"
			out, err := runJobShell(t, prefix+segment)
			if fail && err == nil {
				t.Fatal("SQL failure was discarded")
			}
			if !fail && err != nil {
				t.Fatalf("trust=%s: %v %s", trust, err, out)
			}
		}
	}
}

func TestCronJobsUseTestedDigestScript(t *testing.T) {
	for _, path := range []string{"../../../k8s/platform/auto-update-cronjob.yaml", "../manifests/data/auto-update-cronjob.yaml"} {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
		var script strings.Builder
		active := false
		for _, line := range lines {
			if strings.TrimSpace(line) == "- |" {
				active = true
				continue
			}
			if active && strings.HasPrefix(line, "              ") {
				script.WriteString(strings.TrimPrefix(line, "              "))
				script.WriteByte('\n')
			}
		}
		if strings.TrimSpace(script.String()) != strings.TrimSpace(digestUpdateScript) {
			t.Fatalf("%s does not use the tested digest updater", path)
		}
	}
}
