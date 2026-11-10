package components

import (
	"fmt"

	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/config"
	"github.com/Mpratyush54/SERVER-automation/platformctl/internal/shell"
)

// Runs in the existing MinIO pod: no extra Job, image pull or resident service.
// Root credentials never enter the API's provider row. Existing scoped credentials
// are reused, including after an interrupted provision.
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
pod="$(kubectl -n storage get pods -l app.kubernetes.io/instance=minio,app.kubernetes.io/name=minio -o jsonpath='{.items[0].metadata.name}')"
[[ -n "$pod" ]] || { echo 'MinIO pod unavailable' >&2; exit 1; }
{
  printf 'ROOT_ACCESS=%q\nROOT_SECRET=%q\nAPI_ACCESS=%q\nAPI_SECRET=%q\n' "$ROOT_ACCESS" "$ROOT_SECRET" "$access" "$secret"
  cat <<'MINIO_SETUP'
set -euo pipefail
set +x
umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export MC_CONFIG_DIR="$work/mc"
mc alias set bundled http://127.0.0.1:9000 "$ROOT_ACCESS" "$ROOT_SECRET" >/dev/null 2>&1
mc mb --ignore-existing bundled/platform-uploads >/dev/null 2>&1
mc mb --ignore-existing bundled/platform-backups >/dev/null 2>&1
cat > "$work/policy.json" <<'POLICY'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],"Resource":["arn:aws:s3:::platform-uploads","arn:aws:s3:::platform-backups"]},{"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:AbortMultipartUpload","s3:ListMultipartUploadParts"],"Resource":["arn:aws:s3:::platform-uploads/*","arn:aws:s3:::platform-backups/*"]}]}
POLICY
mc admin policy create bundled platform-api-storage "$work/policy.json" >/dev/null 2>&1
mc admin user add bundled "$API_ACCESS" "$API_SECRET" >/dev/null 2>&1
mc admin policy attach bundled platform-api-storage --user "$API_ACCESS" >/dev/null 2>&1
MINIO_SETUP
} | kubectl -n storage exec -i "$pod" -- /bin/bash -s
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s' "$access" > "$work/MINIO_API_ACCESS_KEY"
printf '%s' "$secret" > "$work/MINIO_API_SECRET_KEY"
kubectl -n platform create secret generic platform-storage --from-file=MINIO_API_ACCESS_KEY="$work/MINIO_API_ACCESS_KEY" --from-file=MINIO_API_SECRET_KEY="$work/MINIO_API_SECRET_KEY" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
`

func SetupBundledStorage(cfg *config.Config) error {
	if err := shell.RunBashEnv(minioStorageScript, map[string]string{"ROOT_ACCESS": cfg.MinioAccessKey, "ROOT_SECRET": cfg.MinioSecretKey}); err != nil {
		return fmt.Errorf("configure scoped MinIO storage credentials: %w", err)
	}
	return nil
}
