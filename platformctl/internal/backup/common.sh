# Shared helpers, prepended to capture.sh and restore.sh by driver.go.
pod() {
  local p
  p=$(kubectl -n databases get pods -l "app.kubernetes.io/instance=$1" -o jsonpath='{.items[0].metadata.name}')
  [ -n "$p" ] || { echo "no running $1 pod" >&2; return 1; }
  printf '%s' "$p"
}
# Prefer the writable CNPG primary, retaining the existing Bitnami selector.
pg_pod() {
  local p
  p=$(kubectl -n databases get pods -l cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -z "$p" ]; then p=$(pod postgresql); fi
  printf '%s' "$p"
}
pg_container() {
  local cluster
  cluster=$(kubectl -n databases get pod "$1" -o jsonpath='{.metadata.labels.cnpg\.io/cluster}')
  if [ "$cluster" = postgresql ]; then printf postgres; else printf postgresql; fi
}
# minio_source: use the configured mc alias, or derive one for the bundled
# MinIO from its Secret and ClusterIP (reachable from the k3s host). The
# credential lives only in this process environment (MC_HOST_*), never on disk.
minio_source() {
  if [ -n "${PLATFORM_BACKUP_MINIO_SOURCE:-}" ]; then MINIO_SRC=$PLATFORM_BACKUP_MINIO_SOURCE; return; fi
  local ip user pass
  ip=$(kubectl -n storage get svc minio -o jsonpath='{.spec.clusterIP}')
  user=$(kubectl -n storage get secret minio -o jsonpath='{.data.root-user}' | base64 -d)
  pass=$(kubectl -n storage get secret minio -o jsonpath='{.data.root-password}' | base64 -d)
  [ -n "$ip" ] && [ -n "$user" ] && [ -n "$pass" ] || { echo "bundled MinIO not found; set minioAlias in backup.json" >&2; return 1; }
  export MC_HOST_platformsrc="http://$(jq -rn --arg v "$user" '$v|@uri'):$(jq -rn --arg v "$pass" '$v|@uri')@$ip:9000"
  MINIO_SRC=platformsrc
}
# Bitnami charts expose passwords either as env vars or as *_FILE paths.
PWHELPER='pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }'
