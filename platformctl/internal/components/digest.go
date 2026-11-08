package components

const digestUpdateScript = `set -euo pipefail
resolve_image() {
  local image="$1" repo tag token digest
  repo="${image%:*}"; tag="${image##*:}"
  local registry path headers challenge realm service
  local -a auth=() credentials=()
  registry="${repo%%/*}"; path="${repo#*/}"
  if [[ -n "${REGISTRY_PASSWORD:-}" ]]; then credentials=(-u "${REGISTRY_USERNAME:?REGISTRY_USERNAME required}:$REGISTRY_PASSWORD"); fi
  headers="$(curl -sSI -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" "https://$registry/v2/$path/manifests/$tag")"
  challenge="$(printf "%s\n" "$headers" | tr -d "\r" | grep -i '^www-authenticate: Bearer ' || true)"
  if [[ -n "$challenge" ]]; then
    realm="$(printf "%s" "$challenge" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')"
    service="$(printf "%s" "$challenge" | sed -n 's/.*service="\([^"]*\)".*/\1/p')"
    [[ "$realm" == https://* ]] || { echo "Registry must use HTTPS token authentication" >&2; return 1; }
    token="$(curl -fsS "${credentials[@]}" --get "$realm" --data-urlencode "service=$service" --data-urlencode "scope=repository:$path:pull" | jq -er '.token // .access_token')"
    auth=(-H "Authorization: Bearer $token")
  fi
  digest="$(curl -fsSI "${auth[@]}" -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" "https://$registry/v2/$path/manifests/$tag" | tr -d "\r" | awk 'tolower($1)=="docker-content-digest:" {print $2}')"
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid registry digest for $image" >&2; return 1; }
  printf "%s@%s" "$repo" "$digest"
}
API="$(resolve_image "$API")"
PORTAL="$(resolve_image "$PORTAL")"
kubectl set image -n platform deploy/platform-api api="$API"
kubectl set image -n platform deploy/platform-portal portal="$PORTAL"
kubectl rollout status -n platform deploy/platform-api --timeout=300s
kubectl rollout status -n platform deploy/platform-portal --timeout=180s
echo "auto-update applied $API $PORTAL"
`
