# Back up a database by hand

Copy one database or bucket with standard tools, for example before a risky change or to move data elsewhere. Everything here runs in a shell on the server; there is nothing to click in the portal.

For regular, encrypted, off-site backups of the whole server, use `platformctl backup --all` instead. See [Back up and restore your server](../operations/backups.md). It captures every component, checks its work and restores in the right order.

## Before you start

Run these as root on a single-server install:

```bash
sudo -i
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
mkdir -p /root/manual-backups && cd /root/manual-backups
```

The commands run the database tools that already exist inside the database containers, and read each password inside the container. You do not need to install database clients or type passwords.

## Quick copy of settings and passwords

```bash
sudo platformctl backup
```

This copies `/etc/platform/.env` and the platform and database Secrets to `/var/lib/platform/backups/<timestamp>/`. It is not encrypted and stays on the same disk. Do this before rotating secrets or editing settings.

## PostgreSQL

Back up the platform's own database (`platform`). Use a project database name, such as `plat_<project>_production`, to back up a project instead:

```bash
PG=$(kubectl -n databases get pods -l app.kubernetes.io/instance=postgresql -o jsonpath='{.items[0].metadata.name}')
kubectl -n databases exec "$PG" -c postgresql -- bash -c \
  'PGPASSWORD="${POSTGRES_PASSWORD:-$(cat "$POSTGRES_PASSWORD_FILE")}" pg_dump -U postgres -Fc platform' \
  > platform-$(date +%Y%m%d-%H%M%S).dump
```

Check the file lists database objects:

```bash
kubectl -n databases exec -i "$PG" -c postgresql -- pg_restore -l < platform-20260101-120000.dump | head
```

Restore it. This replaces the objects in the dump:

```bash
kubectl -n databases exec -i "$PG" -c postgresql -- bash -c \
  'PGPASSWORD="${POSTGRES_PASSWORD:-$(cat "$POSTGRES_PASSWORD_FILE")}" pg_restore -U postgres -d platform --clean --if-exists' \
  < platform-20260101-120000.dump
```

Scale the API down first when restoring the platform database: `kubectl -n platform scale deploy/platform-api --replicas=0`. Scale it back up afterwards.

## MongoDB

```bash
MG=$(kubectl -n databases get pods -l app.kubernetes.io/instance=mongodb --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
kubectl -n databases exec "$MG" -- bash -c \
  'mongodump --username root --password "${MONGODB_ROOT_PASSWORD:-$(cat "$MONGODB_ROOT_PASSWORD_FILE")}" --authenticationDatabase admin --archive --gzip' \
  > mongo-$(date +%Y%m%d-%H%M%S).archive.gz
```

Add `--db <name>` inside the quotes to dump one database. Restore, replacing the collections in the archive:

```bash
kubectl -n databases exec -i "$MG" -- bash -c \
  'mongorestore --username root --password "${MONGODB_ROOT_PASSWORD:-$(cat "$MONGODB_ROOT_PASSWORD_FILE")}" --authenticationDatabase admin --archive --gzip --drop' \
  < mongo-20260101-120000.archive.gz
```

## Redis

Redis holds project data as well as caches. Save a snapshot and copy it out:

```bash
RD=$(kubectl -n databases get pods -l app.kubernetes.io/instance=redis,app.kubernetes.io/component=master -o jsonpath='{.items[0].metadata.name}')
kubectl -n databases exec "$RD" -c redis -- bash -c \
  'REDISCLI_AUTH="${REDIS_PASSWORD:-$(cat "$REDIS_PASSWORD_FILE")}" redis-cli BGSAVE'
# wait until this shows rdb_bgsave_in_progress:0 and rdb_last_bgsave_status:ok
kubectl -n databases exec "$RD" -c redis -- bash -c \
  'REDISCLI_AUTH="${REDIS_PASSWORD:-$(cat "$REDIS_PASSWORD_FILE")}" redis-cli INFO persistence' | grep rdb_
kubectl -n databases exec "$RD" -c redis -- cat /data/dump.rdb > redis-$(date +%Y%m%d-%H%M%S).rdb
```

Restoring a snapshot by hand needs Redis stopped and its append-only file rebuilt. Use `platformctl restore --component redis` from a full backup instead.

## Uploaded files

Files live in the bundled file storage, in the `platform-uploads` bucket. Copy them with the AWS command-line tool, which works with any S3-compatible storage. Install it with `sudo snap install aws-cli --classic`, then, as root on the server:

```bash
IP=$(kubectl -n storage get svc minio -o jsonpath='{.spec.clusterIP}')
export AWS_ACCESS_KEY_ID=$(kubectl -n storage get secret minio -o jsonpath='{.data.root-user}' | base64 -d)
export AWS_SECRET_ACCESS_KEY=$(kubectl -n storage get secret minio -o jsonpath='{.data.root-password}' | base64 -d)
export AWS_DEFAULT_REGION=us-east-1
aws s3 sync s3://platform-uploads ./files/platform-uploads --endpoint-url "http://$IP:9000"
```

To restore, sync the other way: `aws s3 sync ./files/platform-uploads s3://platform-uploads --endpoint-url "http://$IP:9000"`. The keys stay in the shell's environment only; run `unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY` when you are done.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `error: you must specify at least one pod` or an empty `$PG` | The pod is not running. Check `kubectl -n databases get pods`. |
| `container postgresql is not valid` | You are on the `ha` profile. See How it works. |
| `Authentication failed` from MongoDB | Keep `--authenticationDatabase admin`. Check the pod with `kubectl -n databases get pods -l app.kubernetes.io/instance=mongodb`. |
| Backup file is 0 bytes | Check free space with `df -h` and read the command's error output. |
| Restore fails with duplicate keys | Use `--clean --if-exists` (PostgreSQL) or `--drop` (MongoDB). |

## How it works

- The databases run in the `databases` namespace: PostgreSQL (service `postgresql.databases`, port 5432, superuser `postgres`), MongoDB (port 27017, user `root`, auth database `admin`) and Redis (port 6379). Uploaded files are in MinIO in the `storage` namespace.
- The installer's passwords are also in `/etc/platform/.env` as `POSTGRES_PASSWORD`, `MONGO_PASSWORD` and `REDIS_PASSWORD`. Reading them inside the container, as above, keeps them out of shell history and process lists.
- The database charts provide passwords either as environment variables or as `*_FILE` paths; the commands above handle both, the same way `platformctl backup --all` does.
- On the `ha` profile, PostgreSQL runs as a CloudNativePG cluster. Find the primary with `-l cnpg.io/cluster=postgresql,cnpg.io/instanceRole=primary` and use container `postgres`. MongoDB is a replica set: dump from the primary. Redis uses Sentinel: the `component=master` label finds the current primary. HA also has continuous PostgreSQL backups with point-in-time recovery; see [High availability](../operations/ha.md).
- Plain `platformctl backup` saves `env`, a README, and the `platform-env`, `platform-credentials`, `platform-oidc-signing-key`, `postgresql`, `redis` and (if present) `platform-rotate-pending` Secrets as YAML.
- Earlier versions of this page described a daily cron job with fixed retention. No such job is installed; the only scheduled backup is the one `platformctl backup schedule` creates.
