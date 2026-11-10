package components

import (
	"strings"
	"testing"
)

const minioFakeTools = `
set -euo pipefail
ROOT_ACCESS="root-key"
ROOT_SECRET='root secret with $dollar and quote'"'"' and ` + "`" + `backtick'
export ROOT_ACCESS ROOT_SECRET
mc() {
 case "$*" in
  "alias set "*) [[ "$5" == "$ROOT_ACCESS" && "$6" == "$ROOT_SECRET" ]] || return 91 ;;
  "admin user add "*)
    if [[ "${FRESH:-}" == yes ]]; then
      [[ "$5" == platform-api-storage && "$6" =~ ^[a-f0-9]{64}$ ]] || return 92
    else [[ "$6" == 'api secret with $dollar' ]] || return 92; fi ;;
  "admin policy create "*)
    grep -q 'arn:aws:s3:::platform-uploads/\*' "$6" || return 93
    grep -q 'arn:aws:s3:::platform-backups/\*' "$6" || return 94
    if grep -q 's3:\*' "$6"; then return 95; fi ;;
 esac
 [[ "${FAIL_MC:-}" != yes ]] || return 96
}
export -f mc
kubectl() {
 case "$*" in
  *"get secret "*"MINIO_API_ACCESS_KEY"*) [[ "${FRESH:-}" == yes ]] || printf 'api-key' | base64 ;;
  *"get secret "*"MINIO_API_SECRET_KEY"*) [[ "${FRESH:-}" == yes ]] || printf 'api secret with $dollar' | base64 ;;
  *"get pods "*) printf 'minio-0' ;;
  *"exec -i "*) bash -s ;;
  *"create secret "*) echo manifest ;;
  "apply -f -") cat >/dev/null; echo saved ;;
  *) echo "unexpected kubectl $*" >&2; return 97 ;;
 esac
}
`

func TestMinioScopedSetupExecutesAndReusesCredentials(t *testing.T) {
	out, err := runJobShell(t, minioFakeTools+minioStorageScript+"\necho complete\n")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if !strings.Contains(out, "complete") {
		t.Fatal(out)
	}
	if strings.Contains(out, "secret") || strings.Contains(out, "api-key") {
		t.Fatal("credential leaked")
	}
}
func TestMinioScopedSetupFailsClosed(t *testing.T) {
	out, err := runJobShell(t, minioFakeTools+"\nexport FAIL_MC=yes\n"+minioStorageScript)
	if err == nil {
		t.Fatalf("expected mc failure: %s", out)
	}
	if strings.Contains(out, "saved") {
		t.Fatal("published credentials after failure")
	}
}

func TestMinioScopedSetupCreatesFreshCredentials(t *testing.T) {
	out, err := runJobShell(t, minioFakeTools+"\nexport FRESH=yes\n"+minioStorageScript+"\necho complete\n")
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if !strings.Contains(out, "complete") {
		t.Fatal(out)
	}
}
