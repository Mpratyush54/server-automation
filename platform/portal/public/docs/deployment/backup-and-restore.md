# Backup & Restore Procedures

Platform uses three data stores (PostgreSQL, MongoDB, Redis) and MinIO for object storage. This document covers backup and restore for each.

---

## Backup Strategy Overview

| Component | Tool | Schedule | Retention |
|---|---|---|---|
| PostgreSQL | `pg_dump` | Daily (cron) | 7 days local + 30 days MinIO |
| MongoDB | `mongodump` | Daily (cron) | 7 days local + 30 days MinIO |
| Redis | `redis-cli SAVE` / `redis-dump-go` | On-demand only | N/A |
| MinIO | `mc mirror` or API | Weekly cross-bucket | 90 days |
| Kubernetes resources | `kubectl get all --all-namespaces` | On-demand | N/A |

---

## PostgreSQL

### Connection Details

- **Host:** `postgresql.databases` (in-cluster) or `localhost` (port-forwarded)
- **Port:** 5432
- **Database:** `platform`
- **User:** `postgres`
- **Password:** stored in `/etc/platform/.env` as `POSTGRES_PASSWORD`

### Backup (pg_dump)

```bash
# Dump the platform database
pg_dump -h localhost -U postgres -d platform \
  --no-owner --no-acl \
  -F c -f /tmp/backups/platform_$(date +%Y%m%d_%H%M%S).dump

# Plain SQL format (easier to grep, larger)
pg_dump -h localhost -U postgres -d platform \
  --no-owner --no-acl \
  -f /tmp/backups/platform_$(date +%Y%m%d_%H%M%S).sql
```

### Port-Forward for Remote Backup

```bash
# From a remote machine with kubectl access
kubectl port-forward -n databases svc/postgresql 5432:5432 &
sleep 2
pg_dump -h localhost -U postgres -d platform -F c -f backup.dump
kill %1
```

### Automated Daily Backup (cron)

```bash
# Add to crontab
0 2 * * * /usr/local/bin/backup-postgres.sh

# Script: /usr/local/bin/backup-postgres.sh
#!/bin/bash
source /etc/platform/.env
BACKUP_DIR="/tmp/backups/postgres"
mkdir -p "$BACKUP_DIR"
DATE=$(date +%Y%m%d_%H%M%S)
pg_dump -h postgresql.databases -U postgres -d platform \
  --no-owner --no-acl \
  -F c -f "$BACKUP_DIR/platform_$DATE.dump"
# Upload to MinIO
kubectl exec -n storage deploy/minio -- mc alias set local \
  http://localhost:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
kubectl cp "$BACKUP_DIR/platform_$DATE.dump" \
  storage/minio-0:/tmp/
kubectl exec -n storage deploy/minio -- mc cp \
  /tmp/platform_$DATE.dump local/platform-backups/postgres/
# Cleanup old files (older than 7 days)
find "$BACKUP_DIR" -name "*.dump" -mtime +7 -delete
```

### Restore

```bash
# Restore from custom format dump
pg_restore -h localhost -U postgres -d platform \
  --clean --if-exists --no-owner --no-acl \
  -v /tmp/backups/platform_20260101_120000.dump

# Restore from SQL dump
psql -h localhost -U postgres -d platform \
  -f /tmp/backups/platform_20260101_120000.sql
```

### Verify Backup Integrity

```bash
pg_restore -l /tmp/backups/platform_20260101_120000.dump | head -20
# If this lists the database objects, the dump is valid.
```

---

## MongoDB

### Connection Details

- **Host:** `mongodb.databases` (in-cluster) or `localhost` (port-forwarded)
- **Port:** 27017
- **Database:** `platform`
- **Auth DB:** `admin`
- **User:** `root`
- **Password:** stored in `/etc/platform/.env` as `MONGO_PASSWORD`

### Backup (mongodump)

```bash
# Full backup of platform database
mongodump --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --out=/tmp/backups/mongo_$(date +%Y%m%d_%H%M%S)

# Archive format (single file, more portable)
mongodump --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --archive=/tmp/backups/mongo_$(date +%Y%m%d_%H%M%S).archive

# Gzip compression
mongodump --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --gzip --archive=/tmp/backups/mongo_$(date +%Y%m%d_%H%M%S).archive.gz
```

### Backup Specific Collections

```bash
mongodump --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --collection=deployments \
  --out=/tmp/backups/mongo_deployments
```

### Port-Forward for Remote Backup

```bash
kubectl port-forward -n databases svc/mongodb 27017:27017 &
mongodump --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --out=./mongo-backup
kill %1
```

### Restore

```bash
# Restore from directory
mongorestore --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  /tmp/backups/mongo_20260101_120000/platform/

# Restore from archive
mongorestore --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --archive=/tmp/backups/mongo_20260101_120000.archive

# Restore from gzipped archive
mongorestore --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --gzip --archive=/tmp/backups/mongo_20260101_120000.archive.gz
```

### Drop Database Before Restore

```bash
mongosh "mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --eval "db.dropDatabase()"
mongorestore --uri="mongodb://root:$MONGO_PASSWORD@localhost:27017/platform?authSource=admin" \
  --drop /tmp/backups/mongo_20260101_120000/platform/
```

---

## Redis

### Connection Details

- **Host:** `redis-master.databases` (in-cluster) or `localhost` (port-forwarded)
- **Port:** 6379
- **Password:** stored in `/etc/platform/.env` as `REDIS_PASSWORD`

### Backup (RDB Snapshot)

```bash
# Trigger a BGSAVE inside the pod
kubectl exec -n databases redis-master-0 -- redis-cli -a "$REDIS_PASSWORD" BGSAVE

# The dump.rdb file is at /data/dump.rdb inside the pod
kubectl cp databases/redis-master-0:/data/dump.rdb /tmp/backups/redis_$(date +%Y%m%d_%H%M%S).rdb
```

### CLI-Based Backup

```bash
# Export all keys via redis-cli
kubectl exec -n databases redis-master-0 -- sh -c '
  redis-cli -a "$REDIS_PASSWORD" --scan | \
  while read key; do
    redis-cli -a "$REDIS_PASSWORD" dump "$key"
  done
' > /tmp/backups/redis_$(date +%Y%m%d_%H%M%S).json
```

### Restore

```bash
# Copy the backup into the pod
kubectl cp /tmp/backups/redis_20260101_120000.rdb \
  databases/redis-master-0:/data/dump.rdb

# Restart Redis to load the dump
kubectl rollout restart statefulset redis-master -n databases
kubectl rollout status statefulset redis-master -n databases

# Or use the CLI to manually set keys (for JSON backup)
kubectl exec -n databases redis-master-0 -- redis-cli -a "$REDIS_PASSWORD" FLUSHALL
kubectl exec -n databases redis-master-0 -- sh -c '
  while read -r line; do
    echo "$line" | redis-cli -a "$REDIS_PASSWORD" -x restore key 0
  done
' < /tmp/backups/redis_export.json
```

> **Note:** Redis data is ephemeral for session caching. If Redis is lost, the application will recreate sessions. Prioritize PostgreSQL and MongoDB backups.

---

## MinIO (Object Storage)

### Backup via `mc` Client

```bash
# Configure mc client inside the pod
kubectl exec -n storage deploy/minio -- mc alias set local \
  http://localhost:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"

# List buckets
kubectl exec -n storage deploy/minio -- mc ls local/

# Mirror a bucket to another location
kubectl exec -n storage deploy/minio -- mc mirror \
  local/platform-backups local/backup-archive/

# Backup to local filesystem
kubectl exec -n storage deploy/minio -- mc cp \
  --recursive local/platform-backups/ /tmp/minio-backup/
kubectl cp storage/minio-0:/tmp/minio-backup /tmp/backups/minio_$(date +%Y%m%d)
```

### Backup via MinIO API (S3-Compatible)

```bash
# Using AWS CLI (MinIO is S3-compatible)
aws --endpoint-url http://localhost:9000 \
  s3 sync s3://platform-backups \
  /tmp/backups/minio_$(date +%Y%m%d) \
  --access-key "$MINIO_ACCESS_KEY" \
  --secret-key "$MINIO_SECRET_KEY"
```

### Restore

```bash
# From mc
kubectl exec -n storage deploy/minio -- mc cp \
  --recursive /tmp/minio-backup/ local/platform-backups/

# From AWS CLI
aws --endpoint-url http://localhost:9000 \
  s3 sync /tmp/backups/minio_20260101 s3://platform-backups \
  --access-key "$MINIO_ACCESS_KEY" \
  --secret-key "$MINIO_SECRET_KEY"
```

---

## Kubernetes Resources

### Backup All Resources (YAML)

```bash
# Backup all resources to YAML files
NAMESPACES="platform databases monitoring storage argocd portainer infisical"
for ns in $NAMESPACES; do
  kubectl get all,configmap,secret,ingress,pvc -n "$ns" \
    -o yaml > "/tmp/backups/k8s_${ns}_$(date +%Y%m%d).yaml"
done
```

### Restore

```bash
kubectl apply -f /tmp/backups/k8s_platform_20260101.yaml
```

---

## Full Backup Script

Save as `/usr/local/bin/backup-all.sh`:

```bash
#!/bin/bash
source /etc/platform/.env
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/tmp/backups/full_$DATE"
mkdir -p "$BACKUP_DIR"

echo "[$DATE] Starting full backup..."

# PostgreSQL
echo "  Backing up PostgreSQL..."
pg_dump -h postgresql.databases -U postgres -d platform \
  -F c -f "$BACKUP_DIR/postgres.dump"

# MongoDB
echo "  Backing up MongoDB..."
mongodump --uri="mongodb://root:$MONGO_PASSWORD@mongodb.databases:27017/platform?authSource=admin" \
  --gzip --archive="$BACKUP_DIR/mongo.archive.gz"

# Kubernetes
echo "  Backing up Kubernetes resources..."
for ns in platform databases monitoring storage argocd portainer infisical; do
  kubectl get all,configmap,secret,ingress,pvc -n "$ns" -o yaml > "$BACKUP_DIR/k8s_$ns.yaml" 2>/dev/null
done

# MinIO
echo "  Backing up MinIO..."
kubectl exec -n storage deploy/minio -- mc alias set local \
  http://localhost:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" 2>/dev/null
kubectl exec -n storage deploy/minio -- mc mirror \
  local/platform-backups local/backup-archive/ 2>/dev/null

# Compress
echo "  Compressing backup..."
tar -czf "$BACKUP_DIR.tar.gz" -C /tmp/backups "full_$DATE"
rm -rf "$BACKUP_DIR"

echo "[$(date +%Y%m%d_%H%M%S)] Backup complete: $BACKUP_DIR.tar.gz"
```

Make it executable and schedule:

```bash
chmod +x /usr/local/bin/backup-all.sh
echo "0 3 * * * /usr/local/bin/backup-all.sh" | crontab -
```

---

## Restore Procedures Summary

### Full Disaster Recovery

```bash
# 1. Ensure k3s is running and namespaces exist
kubectl get nodes

# 2. Restore Kubernetes resources (ingress, services, deployments)
kubectl apply -f k8s_platform.yaml
kubectl apply -f k8s_databases.yaml
kubectl apply -f k8s_monitoring.yaml
kubectl apply -f k8s_storage.yaml

# 3. Wait for databases to be ready
kubectl wait --for=condition=Available deployment/postgresql -n databases --timeout=300s

# 4. Restore PostgreSQL
pg_restore -h postgresql.databases -U postgres -d platform \
  --clean --if-exists postgres.dump

# 5. Restore MongoDB
mongorestore --uri="mongodb://root:$MONGO_PASSWORD@mongodb.databases:27017/platform?authSource=admin" \
  --gzip --archive=mongo.archive.gz --drop

# 6. Restart Platform pods
kubectl rollout restart deployment -n platform
```

### Point-in-Time Recovery Guidelines

- **PostgreSQL:** Use WAL archiving for PITR (see `postgresql` Helm chart values)
- **MongoDB:** Use oplog replay (`mongorestore --oplogReplay`)
- **MinIO:** Maintain versioning enabled on buckets for object-level recovery

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pg_dump: error: connection refused` | PostgreSQL pod not ready or port not forwarded | `kubectl wait --for=condition=Available deployment/postgresql -n databases` |
| `mongodump: error: Authentication failed` | Wrong password or auth source | Use `?authSource=admin` in URI; verify password in `/etc/platform/.env` |
| `mc: <ERROR> Unable to initialize` | MinIO pod not ready | `kubectl wait --for=condition=Available deployment/minio -n storage` |
| Backup file is 0 bytes | Storage full or write permission denied | `df -h /tmp/backups`; ensure directory exists |
| Restore fails with duplicate key | Existing data conflicts with restore | Use `--drop` (MongoDB) or `--clean --if-exists` (PostgreSQL) |
| `kubectl cp` fails on large files | k3s exec limitation | Use `kubectl exec -- tar cf - /path` piped to local tar |
