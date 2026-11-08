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

Rotate and recover keep durable copies before any database password change:

1. `platformctl backup` (also run automatically by `recover`) copies `/etc/platform/.env` and the Kubernetes Secrets (`platform-env`, `platform-credentials`, `platform-oidc-signing-key`, database secrets) to `/var/lib/platform/backups/<timestamp>/`.
2. One-click rotate (portal) writes the previous/next passwords to the `platform/platform-credentials` Secret (`POSTGRES_PASSWORD_PREV`, `POSTGRES_PASSWORD_NEXT`, ...) and to `platform/platform-rotate-pending` **before** `ALTER USER`. If neither can be written, rotate **refuses** to change Postgres. The API no longer writes host files; `platformctl update` copies the new values to `/etc/platform` afterwards.
3. `platformctl recover` reads the Secrets first, writes the passwords to the root-only host copy `/etc/platform/.env` and `/etc/platform/credentials/{admin,postgres,redis}` (mode 0600) **before** any `ALTER USER`, tries stored passwords first and **does not ALTER** if one still works, then syncs `platform-credentials`.
4. On API boot, `getDb()` tries env, pending, `platform-credentials` (incl. previous/next), `platform-env` and the Bitnami secret, then syncs the working password to `platform-credentials`.

Passwords are not only flashed in the terminal. Read them with:

```bash
sudo cat /etc/platform/credentials/admin
sudo cat /etc/platform/credentials/postgres
sudo grep -E '^(ADMIN|POSTGRES|REDIS)_PASSWORD=' /etc/platform/.env
```

## If a pod is still crash-looping

On the k3s host:

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | bash
sudo platformctl backup
sudo platformctl recover
sudo platformctl update
```

`recover` prints the backup directory and `/etc/platform/credentials/*` paths. Admin login is in `credentials/admin` and `ADMIN_PASSWORD` in `/etc/platform/.env`.

Roll to an image that includes in-cluster credential recovery (`platform-api` after this change) with `platformctl update`. A new API pod heals on start as long as any stored password copy still matches the database role.

## Manual fallback (only if every stored copy is wrong)

Do **not** recreate `platform-env` or `platform-credentials` with `kubectl create secret … | kubectl apply`. That wipes other keys.

Patch a single key (credentials live in `platform-credentials`):

```bash
# Encode a known-good password (the value Postgres actually accepts)
ENC=$(printf '%s' 'known-good-password' | base64 -w0)
kubectl -n platform patch secret platform-credentials --type merge -p "{\"data\":{\"POSTGRES_PASSWORD\":\"$ENC\"}}"
kubectl -n databases patch secret postgresql --type merge -p "{\"data\":{\"postgres-password\":\"$ENC\",\"password\":\"$ENC\"}}"
kubectl -n platform rollout restart deployment/platform-api
```

Keep `/etc/platform/.env` in sync so a later bootstrap does not re-apply a stale password:

```bash
sudo sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD='known-good-password'/" /etc/platform/.env
```
