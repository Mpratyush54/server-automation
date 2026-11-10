package components

import (
	"fmt"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// Runs in the existing MinIO pod: no extra Job, image pull or resident service.
// Root credentials never enter the API's provider row. Existing scoped credentials
// are reused, including after an interrupted provision.
//
// MinIO uses the platform API as its OpenID provider, and its IAM (users and
// policies) only initialises once that issuer answers. So this runs as its own
// provision step after "platform": it waits for the admin API, creates the
// scoped user, publishes the credentials to platform-env and restarts the API
// when they changed. Until then the API uses the root credentials, as before.
const minioStorageScript = `
set -euo pipefail
set +x
umask 077
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
access="$(kubectl -n platform get secret platform-storage -o jsonpath='{.data.MINIO_API_ACCESS_KEY}' 2>/dev/null | base64 -d || true)"
secret="$(kubectl -n platform get secret platform-storage -o jsonpath='{.data.MINIO_API_SECRET_KEY}' 2>/dev/null | base64 -d || true)"
if [[ -z "$access" || -z "$secret" ]]; then
  access="platform-api-storage"
  secret="$(openssl rand -hex 32)"
fi
pod="$(kubectl -n storage get pods -l app.kubernetes.io/instance=minio,app.kubernetes.io/component=minio -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$pod" ]] || { echo 'MinIO pod unavailable' >&2; exit 1; }
{
  printf 'ROOT_ACCESS=%q\nROOT_SECRET=%q\nAPI_ACCESS=%q\nAPI_SECRET=%q\nADMIN_WAIT=%q\n' "$ROOT_ACCESS" "$ROOT_SECRET" "$access" "$secret" "${MINIO_ADMIN_WAIT_SECONDS:-600}"
  cat <<'MINIO_SETUP'
set -euo pipefail
set +x
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export MC_CONFIG_DIR="$work/mc"
step() { local name="$1"; shift; "$@" >/dev/null 2>&1 || { echo "MinIO setup failed at: $name" >&2; exit 1; }; }
step "alias" mc alias set bundled http://127.0.0.1:9000 "$ROOT_ACCESS" "$ROOT_SECRET"
# IAM answers "Server not initialized" until the OpenID issuer (platform API) is reachable.
waited=0
until mc admin policy list bundled >/dev/null 2>&1; do
  if (( waited >= ADMIN_WAIT )); then echo "MinIO admin API not ready after ${ADMIN_WAIT}s (is the platform API OpenID issuer reachable?)" >&2; exit 1; fi
  sleep 5; waited=$((waited + 5))
done
step "create bucket platform-uploads" mc mb --ignore-existing bundled/platform-uploads
step "create bucket platform-backups" mc mb --ignore-existing bundled/platform-backups
cat > "$work/policy.json" <<'POLICY'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::platform-uploads","arn:aws:s3:::platform-backups"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::platform-uploads/*","arn:aws:s3:::platform-backups/*"]}]}
POLICY
step "create policy" mc admin policy create bundled platform-api-storage "$work/policy.json"
step "add user" mc admin user add bundled "$API_ACCESS" "$API_SECRET"
# attach fails when the policy is already attached (re-run): check the mapping instead.
mc admin policy attach bundled platform-api-storage --user "$API_ACCESS" >/dev/null 2>&1 \
  || mc admin user info bundled "$API_ACCESS" 2>/dev/null | grep -q 'platform-api-storage' \
  || { echo "MinIO setup failed at: attach policy" >&2; exit 1; }
MINIO_SETUP
} | kubectl -n storage exec -i "$pod" -- /bin/bash -s
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s' "$access" > "$work/MINIO_API_ACCESS_KEY"
printf '%s' "$secret" > "$work/MINIO_API_SECRET_KEY"
kubectl -n platform create secret generic platform-storage --from-file=MINIO_API_ACCESS_KEY="$work/MINIO_API_ACCESS_KEY" --from-file=MINIO_API_SECRET_KEY="$work/MINIO_API_SECRET_KEY" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# Publish to the API environment (patch file: values never on a command line).
cur_access="$(kubectl -n platform get secret platform-env -o jsonpath='{.data.MINIO_API_ACCESS_KEY}' 2>/dev/null | base64 -d || true)"
cur_secret="$(kubectl -n platform get secret platform-env -o jsonpath='{.data.MINIO_API_SECRET_KEY}' 2>/dev/null | base64 -d || true)"
if [[ "$cur_access" != "$access" || "$cur_secret" != "$secret" ]]; then
  printf '{"data":{"MINIO_API_ACCESS_KEY":"%s","MINIO_API_SECRET_KEY":"%s"}}' "$(printf '%s' "$access" | base64 | tr -d '\n')" "$(printf '%s' "$secret" | base64 | tr -d '\n')" > "$work/patch.json"
  kubectl -n platform patch secret platform-env --type merge --patch-file "$work/patch.json" >/dev/null
  kubectl -n platform rollout restart deployment/platform-api >/dev/null
  echo "scoped storage credentials published; API restarted"
else
  echo "scoped storage credentials unchanged"
fi
`

// SetupBundledStorage creates the API's bucket-scoped MinIO user (provision step
// "storage-scoped", after "platform").
func SetupBundledStorage(cfg *config.Config) error {
	fmt.Println("  ■ Configuring scoped MinIO credentials for the API...")
	if err := shell.RunBashEnv(minioStorageScript, map[string]string{"ROOT_ACCESS": cfg.MinioAccessKey, "ROOT_SECRET": cfg.MinioSecretKey}); err != nil {
		return fmt.Errorf("configure scoped MinIO storage credentials: %w", err)
	}
	return nil
}
