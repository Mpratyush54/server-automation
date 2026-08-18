# Database auth errors after rotating passwords

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

## What the platform does by itself

Rotate and recover keep durable copies **on the host** before any database password change:

1. `platformctl backup` (also run automatically by `recover`) copies `/etc/platform/.env` and Kubernetes secrets to `/var/lib/platform/backups/<timestamp>/`.
2. Live passwords are written to `/etc/platform/.env` and `/etc/platform/credentials/{admin,postgres,redis}` (mode 0600) **before** `ALTER USER`. Previous/next values are stored as `postgres.prev` / `postgres.next`.
3. One-click rotate also writes `platform/platform-rotate-pending`. If neither the host files nor that secret can be written, rotate **refuses** to change Postgres.
4. `platformctl recover` tries stored passwords first and **does not ALTER** if one still works. It only ALTERs when nothing authenticates, and only to a password already fsynced on disk.
5. On API boot, `getDb()` still tries env, pending, `platform-env`, and the Bitnami secret, then syncs the working password.

Passwords are not only flashed in the terminal. Read them with:

```bash
sudo cat /etc/platform/credentials/admin
sudo cat /etc/platform/credentials/postgres
sudo grep -E '^(ADMIN|POSTGRES|REDIS)_PASSWORD=' /etc/platform/.env
```

## If a pod is still crash-looping

On the k3s host:

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | sh
sudo platformctl backup
sudo platformctl recover
sudo platformctl update
```

`recover` prints the backup directory and `/etc/platform/credentials/*` paths. Admin login is in `credentials/admin` and `ADMIN_PASSWORD` in `/etc/platform/.env`.

Roll to an image that includes in-cluster credential recovery (`platform-api` after this change) with `platformctl update`. A new API pod heals on start as long as any stored password copy still matches the database role.

## Manual fallback (only if every stored copy is wrong)

Do **not** recreate `platform-env` with `kubectl create secret … | kubectl apply`. That wipes GitHub/GitLab tokens.

Patch a single key:

```bash
# Encode a known-good password (the value Postgres actually accepts)
ENC=$(printf '%s' 'known-good-password' | base64 -w0)
kubectl -n platform patch secret platform-env --type merge -p "{\"data\":{\"POSTGRES_PASSWORD\":\"$ENC\"}}"
kubectl -n databases patch secret postgresql --type merge -p "{\"data\":{\"postgres-password\":\"$ENC\",\"password\":\"$ENC\"}}"
kubectl -n platform rollout restart deployment/platform-api
```

Keep `/etc/platform/.env` in sync so a later bootstrap does not re-apply a stale password:

```bash
sudo sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD='known-good-password'/" /etc/platform/.env
```
