# Shared helpers, prepended to capture.sh and restore.sh by driver.go.
# Bitnami charts expose passwords either as env vars or as *_FILE paths.
PWHELPER='pw() { local v="${!1:-}" f="${1}_FILE"; if [ -z "$v" ] && [ -n "${!f:-}" ]; then v=$(cat "${!f}"); fi; printf "%s" "$v"; }'
pod() {
  local p
  p=$(kubectl -n databases get pods -l "app.kubernetes.io/instance=$1" -o jsonpath='{.items[0].metadata.name}')
  [ -n "$p" ] || { echo "no running $1 pod" >&2; return 1; }
  printf '%s' "$p"
}
# mongo_pod: standalone returns the single Running pod; replica-set returns the
# writable primary (db.hello().isWritablePrimary).
mongo_pod() {
  local pods p out
  pods=$(kubectl -n databases get pods -l 'app.kubernetes.io/instance=mongodb' --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
  [ -n "$pods" ] || { echo "no running mongodb pod" >&2; return 1; }
  if [ "$(printf '%s\n' "$pods" | grep -c .)" -eq 1 ]; then
    printf '%s' "$(printf '%s\n' "$pods" | head -n1)"
    return 0
  fi
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    out=$(kubectl -n databases exec "$p" -c mongodb -- mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null || true)
    if [ "$out" = "true" ]; then
      printf '%s' "$p"
      return 0
    fi
  done <<EOF
$pods
EOF
  echo "no writable mongodb primary" >&2
  return 1
}
# redis_master_pod: prefer the standalone master label; otherwise find the
# Sentinel-mode node whose INFO replication reports role:master.
redis_master_pod() {
  local p pods info
  p=$(kubectl -n databases get pods -l 'app.kubernetes.io/instance=redis,app.kubernetes.io/component=master' --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -n "$p" ]; then
    printf '%s' "$p"
    return 0
  fi
  pods=$(kubectl -n databases get pods -l 'app.kubernetes.io/instance=redis,app.kubernetes.io/component=node' --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
  [ -n "$pods" ] || { echo "no running redis master pod" >&2; return 1; }
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    info=$(kubectl -n databases exec "$p" -c redis -- bash -ec "$PWHELPER"'export REDISCLI_AUTH="$(pw REDIS_PASSWORD)"; redis-cli INFO replication' 2>/dev/null || true)
    if printf '%s' "$info" | grep -q 'role:master'; then
      printf '%s' "$p"
      return 0
    fi
  done <<EOF
$pods
EOF
  echo "no redis master among redis-node pods" >&2
  return 1
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
