set -euo pipefail
umask 077
component=$1
dest=$2
case "$component" in
config)
  cp /etc/platform/.env "$dest/env"
  # Public-only backup settings (target + age recipient), for restore on a new VM.
  if [ -f /etc/platform/backup.json ]; then cp /etc/platform/backup.json "$dest/backup-config.json"; fi
  if [ -d /etc/platform/credentials ]; then cp -R /etc/platform/credentials "$dest/credentials"; fi
  # Include database/storage credentials and ArgoCD repository secrets too.
  for ns in platform databases storage argocd cert-manager; do
    if kubectl get namespace "$ns" >/dev/null 2>&1; then
      kubectl -n "$ns" get secrets -o json > "$dest/secrets-$ns.json"
    fi
  done
  if kubectl get crd applications.argoproj.io >/dev/null 2>&1; then
    kubectl get applications.argoproj.io -A -o json > "$dest/applications.json"
  fi
  if kubectl get crd clusterissuers.cert-manager.io >/dev/null 2>&1; then
    kubectl get clusterissuers.cert-manager.io -o json > "$dest/clusterissuers.json"
    kubectl get issuers.cert-manager.io -A -o json > "$dest/issuers.json"
  fi
  ;;
postgres)
  p=$(pod postgresql)
  kubectl -n databases exec "$p" -- bash -ec "$PWHELPER"'
    export PGPASSWORD="$(pw POSTGRES_PASSWORD)"
    pg_dumpall -U postgres --globals-only
  ' > "$dest/globals.sql"
  # Database names are data, never interpolated into shell source or filenames.
  kubectl -n databases exec "$p" -- bash -ec "$PWHELPER"'
    export PGPASSWORD="$(pw POSTGRES_PASSWORD)"
    work=$(mktemp -d); trap '\''rm -rf "$work"'\'' EXIT
    psql -U postgres -At -0 -c "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname" > "$work/names"
    i=0
    while IFS= read -r -d "" db; do
      pg_dump -U postgres -Fc --dbname="$db" --file="$work/$i.dump"
      i=$((i+1))
    done < "$work/names"
    tar -C "$work" -cf - .
  ' > "$dest/databases.tar"
  ;;
mongo)
  p=$(mongo_pod)
  kubectl -n databases exec "$p" -- bash -ec "$PWHELPER"'
    mongodump --username root --password "$(pw MONGODB_ROOT_PASSWORD)" --authenticationDatabase admin --archive --gzip' > "$dest/mongo.archive.gz"
  ;;
redis)
  p=$(redis_master_pod)
  kubectl -n databases exec "$p" -c redis -- bash -ec "$PWHELPER"'
    export REDISCLI_AUTH="$(pw REDIS_PASSWORD)"
    result=$(redis-cli BGSAVE)
    case "$result" in "Background saving started"|"Background saving already in progress"*) ;; *) echo "Redis BGSAVE failed" >&2;exit 1;; esac
    for i in $(seq 1 120); do
      info=$(redis-cli INFO persistence)
      if ! printf "%s" "$info" | grep -q "rdb_bgsave_in_progress:1"; then
        printf "%s" "$info" | grep -q "rdb_last_bgsave_status:ok"
        cat /data/dump.rdb
        exit 0
      fi
      sleep 1
    done
    exit 1
  ' > "$dest/dump.rdb"
  ;;
minio)
  # The SOURCE alias is distinct from the backup target.
  minio_source
  mkdir "$dest/objects"
  mc ls --json "$MINIO_SRC/" | jq -r 'select(.type == "folder") | .key' > "$dest/buckets"
  while IFS= read -r bucket; do
    bucket=${bucket%/}
    [ "$bucket" != platform-backups ] || continue
    case "$bucket" in ''|*[!a-z0-9.-]*|.|..) echo 'Invalid source bucket' >&2;exit 1;; esac
    mkdir "$dest/objects/$bucket"
    mc mirror "$MINIO_SRC/$bucket/" "$dest/objects/$bucket/"
  done < "$dest/buckets"
  ;;
k3s)
  cp /var/lib/rancher/k3s/server/token "$dest/server-token"
  cp /etc/rancher/k3s/k3s.yaml "$dest/k3s.yaml"
  if [ -d /var/lib/rancher/k3s/server/db/etcd ]; then
    # Use a unique private snapshot directory; do not collect stale snapshots.
    k3s etcd-snapshot save --name platform-backup --etcd-snapshot-dir "$dest/etcd"
    printf 'etcd\n' > "$dest/datastore"
  else
    # VACUUM INTO copies a consistent snapshot (committed WAL included) inside
    # one read transaction, without stopping k3s. Do not use the sqlite3 .backup command: the
    # online backup API restarts whenever another connection writes, and k3s
    # writes continuously, so on a live cluster it can spin forever.
    sqlite3 -cmd '.timeout 30000' /var/lib/rancher/k3s/server/db/state.db "VACUUM INTO '$dest/state.db'"
    [ "$(sqlite3 "$dest/state.db" 'PRAGMA quick_check;')" = ok ] || { echo 'k3s datastore snapshot failed integrity check' >&2; exit 1; }
    printf 'sqlite\n' > "$dest/datastore"
  fi
  ;;
*) echo 'unsupported capture component' >&2; exit 1 ;;
esac
