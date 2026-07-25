# `WRONGPASS` in `platform-api` logs after rotating a DB password

## Symptom

The API pod keeps restarting. `kubectl logs -n platform deploy/platform-api` shows:

```
⚠️  Redis error: WRONGPASS invalid username-password pair or user is disabled.
[ioredis] Unhandled error event: ReplyError: WRONGPASS ...
```

Or for Postgres:

```
error: password authentication failed for user "postgres"
```

## Root Cause

Somebody rotated the database's admin password (a leaked credential, or a
scheduled rotation) but the Kubernetes `platform-env` Secret still contains the
**old** password. The API reads env vars once at boot, gets rejected by the DB
on every connection attempt, and enters a crash-loop.

Common trigger: after a secret leak (e.g. connection string committed to Git),
you rotated Postgres/Mongo/Redis on-cluster but forgot the corresponding entry
in `platform-env`.

## Fix

### 1. Confirm the actual DB password

```bash
# PostgreSQL
kubectl -n databases get secret postgresql -o jsonpath='{.data.postgres-password}' | base64 -d; echo

# Redis
kubectl -n databases get secret redis -o jsonpath='{.data.redis-password}' | base64 -d; echo

# MongoDB
kubectl -n databases get secret mongodb -o jsonpath='{.data.mongodb-root-password}' | base64 -d; echo
```

### 2. Update the API's `platform-env` Secret

```bash
kubectl -n platform edit secret platform-env
```

Values are base64-encoded — use `echo -n '<new-password>' | base64` to encode.

Or, quicker, patch the specific keys:

```bash
NEW_PG=$(kubectl -n databases get secret postgresql -o jsonpath='{.data.postgres-password}' | base64 -d)
NEW_RD=$(kubectl -n databases get secret redis      -o jsonpath='{.data.redis-password}'    | base64 -d)
NEW_MG=$(kubectl -n databases get secret mongodb    -o jsonpath='{.data.mongodb-root-password}' | base64 -d)

kubectl -n platform create secret generic platform-env \
  --from-literal=POSTGRES_PASSWORD="$NEW_PG" \
  --from-literal=REDIS_PASSWORD="$NEW_RD" \
  --from-literal=MONGODB_URI="mongodb://root:$NEW_MG@mongodb.databases:27017/platform?authSource=admin" \
  --dry-run=client -o yaml | kubectl apply -f -
```

> **Note:** `create secret ... --dry-run=client | apply -f -` **replaces** the
> Secret. If you had integration tokens (GitHub, GitLab, ClickUp, SMTP) in the
> same Secret, use `kubectl edit` instead, or re-run the bootstrap.

### 3. Sync `/etc/platform/.env` on disk

The `.env` file on the host is the source of truth for a re-run of the bootstrap.
Keep it in sync:

```bash
sudo sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD='$NEW_PG'/" /etc/platform/.env
sudo sed -i "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD='$NEW_RD'/"       /etc/platform/.env
sudo sed -i "s/^MONGO_PASSWORD=.*/MONGO_PASSWORD='$NEW_MG'/"       /etc/platform/.env
```

### 4. Roll the API

```bash
kubectl -n platform rollout restart deployment/platform-api
kubectl -n platform rollout status  deployment/platform-api
```

## Verification

```bash
kubectl -n platform logs deploy/platform-api --tail=20
```

Expected: `✅ Connected to Redis`, `✅ Connected to Postgres`, no `WRONGPASS`.
