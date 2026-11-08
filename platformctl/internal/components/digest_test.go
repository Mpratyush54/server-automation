package components

import (
	"os"
	"os/exec"
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
kubectl() {
 if [[ "$1 $2" == "set image" ]]; then
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
	out, err := exec.Command(bash, "-c", script).CombinedOutput()
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
	for _, setup := range []string{"DIGEST=invalid", "FAIL_ROLLOUT=1"} {
		script := digestTestTools + "\n" + setup + "\nAPI=ghcr.io/test/platform-api:latest\nPORTAL=ghcr.io/test/platform-portal:latest\n" + digestUpdateScript
		if out, err := runJobShell(t, script); err == nil {
			t.Fatalf("job ignored %s: %s", setup, out)
		}
	}
}
func TestRecoveryAdminSQLAlwaysAuthenticatesAndPropagatesFailure(t *testing.T) {
	start := strings.Index(recoverScript, "kubectl -n databases exec -i \"$PG_POD\" -- bash -lc 'cat > /tmp/platformctl-recover-admin.sql'")
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
			prefix := "set -euo pipefail\nWORKING=known-working\nPG_POD=postgresql-0\nSQL_FILE=/dev/null\nUSED_TRUST=" + trust + "\nkubectl() { return 0; }\npsql_with_pw() { [[ $1 == known-working && $2 == platform ]] || return 99; return " + status + "; }\n"
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
