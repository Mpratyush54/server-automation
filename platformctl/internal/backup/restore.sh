set -euo pipefail
umask 077
component=$1
src=$2
case "$component" in
config)
  # Strip cluster-owned metadata before applying objects to a fresh cluster.
  # Helm release records and service-account tokens belong to the new cluster.
  # Server-side apply avoids the client-side last-applied annotation size limit.
  for f in "$src"/*.json; do
    [ -f "$f" ] || continue
    [ "${f##*/}" != backup-config.json ] || continue
    doc=$(jq 'del(.metadata) | .items |= map(select(.type != "kubernetes.io/service-account-token" and .type != "helm.sh/release.v1") | del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.generation,.status) | if .kind == "Secret" then del(.metadata.annotations."kubectl.kubernetes.io/last-applied-configuration") else . end)' "$f")
    # A namespace whose Secrets are all filtered out leaves an empty list, and
    # `kubectl apply` rejects that ("no objects passed to apply").
    [ "$(printf '%s' "$doc" | jq '.items | length')" -gt 0 ] || continue
    printf '%s' "$doc" | kubectl apply --server-side --force-conflicts -f -
  done
  install -d -m 700 /etc/platform
  install -m 600 "$src/env" /etc/platform/.env
  if [ -d "$src/credentials" ]; then cp -R "$src/credentials" /etc/platform/; chmod -R go-rwx /etc/platform/credentials; fi
  if [ -f "$src/backup-config.json" ] && [ ! -f /etc/platform/backup.json ]; then install -m 600 "$src/backup-config.json" /etc/platform/backup.json; fi
  # Runs LAST (see engine.go): data components were restored with the fresh
  # cluster's credentials and already reset Postgres/Mongo users to the backed-up
  # passwords. Credential-only services read Secrets at start: restart them so
  # they match the restored platform-env.
  if kubectl -n storage get deploy minio >/dev/null 2>&1; then
    kubectl -n storage rollout restart deploy/minio
    kubectl -n storage rollout status deploy/minio --timeout=300s
  fi
  if kubectl -n storage get sts minio >/dev/null 2>&1; then
    kubectl -n storage rollout restart sts/minio
    kubectl -n storage rollout status sts/minio --timeout=300s
  fi
  if kubectl -n databases get sts redis-master >/dev/null 2>&1; then
    kubectl -n databases rollout restart sts/redis-master
    kubectl -n databases rollout status sts/redis-master --timeout=300s
  fi
  if kubectl -n databases get sts redis-node >/dev/null 2>&1; then
    kubectl -n databases rollout restart sts/redis-node
    kubectl -n databases rollout status sts/redis-node --timeout=300s
  fi
  ;;
postgres)
  p=$(pod postgresql)
  remote=$(kubectl -n databases exec "$p" -- mktemp -d)
  trap 'kubectl -n databases exec "$p" -- rm -rf "$remote"' EXIT
  kubectl -n databases cp "$src/globals.sql" "$p:$remote/globals.sql"
  kubectl -n databases cp "$src/databases.tar" "$p:$remote/databases.tar"
  kubectl -n databases exec "$p" -- bash -ec "$PWHELPER"'
    export PGPASSWORD="$(pw POSTGRES_PASSWORD)"
    work=$1
    # The bootstrap superuser already exists. Keep its current password until
    # all restores finish, then restore its original credentials last.
    # This script is one single-quoted argument: embed single quotes as '\''.
    sed '\''/^CREATE ROLE postgres;$/d; /^ALTER ROLE postgres /d'\'' "$work/globals.sql" | psql -U postgres -d template1 -v ON_ERROR_STOP=1
    tar -C "$work" -xf "$work/databases.tar"
    # Writers are stopped; drop leftover sessions so --clean can drop databases.
    psql -U postgres -d template1 -v ON_ERROR_STOP=1 -Atc "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname IS NOT NULL AND datname <> '\''template1'\''" >/dev/null
    for dump in "$work"/*.dump; do
      pg_restore -U postgres -d template1 --clean --if-exists --create --exit-on-error "$dump"
    done
    grep "^ALTER ROLE postgres " "$work/globals.sql" | psql -U postgres -d template1 -v ON_ERROR_STOP=1
  ' -- "$remote"
  ;;
mongo)
  p=$(mongo_pod)
  remote=$(kubectl -n databases exec "$p" -- mktemp -d)
  trap 'kubectl -n databases exec "$p" -- rm -rf "$remote"' EXIT
  kubectl -n databases cp "$src/mongo.archive.gz" "$p:$remote/mongo.archive.gz"
  kubectl -n databases exec "$p" -- bash -ec "$PWHELPER"'
    opts=(--username root --password "$(pw MONGODB_ROOT_PASSWORD)" --authenticationDatabase admin --gzip "--archive=$1/mongo.archive.gz")
    # Data first, users and roles last. Replacing admin.system.users removes
    # the user this session authenticated as: when that happened first, every
    # later command failed ("requires authentication") and left the restore
    # half done. As the final step it is one server-side merge, which also
    # gives root its backed-up password. (Without --drop, existing users are
    # not updated.)
    mongorestore "${opts[@]}" --drop "--nsExclude=admin.system.*"
    mongorestore "${opts[@]}" --drop "--nsInclude=admin.system.users" "--nsInclude=admin.system.roles"
  ' -- "$remote"
  ;;
minio)
  minio_source
  for bucket_dir in "$src/objects"/*; do
    [ -d "$bucket_dir" ] || continue
    bucket=${bucket_dir##*/}
    mc mb --ignore-existing "$MINIO_SRC/$bucket"
    mc mirror --overwrite "$bucket_dir/" "$MINIO_SRC/$bucket/"
  done
  ;;
redis)
  p=$(redis_master_pod)
  sts=$(kubectl -n databases get pod "$p" -o jsonpath='{.metadata.ownerReferences[?(@.kind=="StatefulSet")].name}')
  image=$(kubectl -n databases get pod "$p" -o jsonpath='{.spec.containers[0].image}')
  test -n "$sts" && test -n "$image"
  replicas=$(kubectl -n databases get sts "$sts" -o jsonpath='{.spec.replicas}')
  # Collect PVCs redis-data-$sts-$i that exist (standalone: redis-data-redis-master-0).
  pvcs=()
  i=0
  while [ "$i" -lt "$replicas" ]; do
    claim="redis-data-$sts-$i"
    if kubectl -n databases get pvc "$claim" >/dev/null 2>&1; then
      pvcs+=("$claim")
    fi
    i=$((i + 1))
  done
  test "${#pvcs[@]}" -gt 0
  helper="platform-redis-restore-$(date +%s)"
  cleanup() {
    kubectl -n databases delete pod "$helper" --ignore-not-found --wait=true
    kubectl -n databases scale sts "$sts" --replicas="$replicas"
  }
  trap cleanup EXIT
  kubectl -n databases scale sts "$sts" --replicas=0
  # Wait for every pod of this StatefulSet to be gone (Sentinel: all nodes).
  i=0
  while [ "$i" -lt "$replicas" ]; do
    kubectl -n databases wait --for=delete "pod/$sts-$i" --timeout=180s 2>/dev/null || true
    i=$((i + 1))
  done
  restore_redis_pvc() {
    local pvc="$1"
    kubectl -n databases delete pod "$helper" --ignore-not-found --wait=true
    jq -n --arg name "$helper" --arg pvc "$pvc" --arg image "$image" '{apiVersion:"v1",kind:"Pod",metadata:{name:$name,namespace:"databases"},spec:{restartPolicy:"Never",automountServiceAccountToken:false,securityContext:{runAsUser:1001,fsGroup:1001},containers:[{name:"restore",image:$image,command:["sleep","3600"],resources:{requests:{cpu:"50m",memory:"64Mi"},limits:{cpu:"1",memory:"512Mi"}},volumeMounts:[{name:"data",mountPath:"/data"}]}],volumes:[{name:"data",persistentVolumeClaim:{claimName:$pvc}}]}}' | kubectl apply -f -
    kubectl -n databases wait --for=condition=Ready "pod/$helper" --timeout=180s
    kubectl -n databases cp "$src/dump.rdb" "$helper:/data/dump.rdb"
    # Bitnami enables AOF by default. Build a matching AOF from the restored RDB
    # using the installed Redis version, or old AOF data would override the RDB.
    kubectl -n databases exec "$helper" -- bash -ec '
      rm -rf /data/appendonlydir /data/appendonly.aof
      redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --port 0 --unixsocket /tmp/restore.sock --logfile /tmp/restore.log --daemonize yes
      # --daemonize returns before the RDB is loaded and the socket is open.
      for i in $(seq 1 60); do
        [ "$(redis-cli -s /tmp/restore.sock PING 2>/dev/null)" = PONG ] && break
        [ "$i" = 60 ] && { echo "redis-server did not start:" >&2; tail -20 /tmp/restore.log >&2; exit 1; }
        sleep 1
      done
      redis-cli -s /tmp/restore.sock CONFIG SET appendonly yes
      for i in $(seq 1 180); do
        info=$(redis-cli -s /tmp/restore.sock INFO persistence)
        if printf "%s" "$info" | grep -q "aof_rewrite_in_progress:0"; then
          printf "%s" "$info" | grep -q "aof_last_bgrewrite_status:ok"
          redis-cli -s /tmp/restore.sock SHUTDOWN NOSAVE
          exit 0
        fi
        sleep 1
      done
      exit 1
    '
    kubectl -n databases delete pod "$helper" --ignore-not-found --wait=true
  }
  for claim in "${pvcs[@]}"; do
    restore_redis_pvc "$claim"
  done
  ;;
k3s)
  if systemctl is-active --quiet k3s; then
    echo 'Stop k3s before restoring its datastore (see docs/operations/backups.md)' >&2; exit 1
  fi
  # Keep the current datastore as a rollback copy. The original token is needed
  # to decrypt k3s bootstrap data; never replace a running datastore.
  server=/var/lib/rancher/k3s/server
  install -m 600 "$src/server-token" "$server/token"
  if [ "$(cat "$src/datastore")" = sqlite ]; then
    mv "$server/db" "$server/db.before-restore-$(date +%s)"
    install -d -m 700 "$server/db"
    install -m 600 "$src/state.db" "$server/db/state.db"
  elif [ "$(cat "$src/datastore")" = etcd ]; then
    mapfile -t snapshots < <(find "$src/etcd" -type f ! -name '*.metadata')
    test "${#snapshots[@]}" = 1
    k3s server --cluster-reset --cluster-reset-restore-path="${snapshots[0]}" --token-file="$server/token"
  else
    echo 'Unsupported k3s datastore' >&2; exit 1
  fi
  echo 'Datastore restored. Start k3s and verify cluster health before restoring logical data.'
  ;;
*) exit 1 ;;
esac
