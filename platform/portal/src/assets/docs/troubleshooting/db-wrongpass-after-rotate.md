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

From this release on, `platform-api` recovers without SSH:

1. One-click rotate writes old + new passwords to `platform/platform-rotate-pending` **before** `ALTER USER` / Redis `CONFIG SET`.
2. Live passwords are changed only if that command succeeds. Kubernetes secrets are patched only after that.
3. TypeORM is reconnected in-process after a successful Postgres `ALTER USER` (it cannot keep using the old password).
4. On the next boot, if Postgres still rejects `POSTGRES_PASSWORD`, the API tries every remaining copy:
   - process env
   - `platform-rotate-pending` (`POSTGRES_PASSWORD_NEW`, then `POSTGRES_PASSWORD_OLD`)
   - `platform/platform-env`
   - `databases/postgresql` (`postgres-password` / `password`)
5. The first password that authenticates is written back to `platform-env` and the Bitnami secret. Redis `WRONGPASS` uses the same pattern.

A new API pod coming up after a partial rotate should log `postgres auth recovered from …` and stay Ready. You do not need to exec into the node.

## If a pod is still crash-looping

On the k3s host (no API login required):

```bash
curl -fsSL https://github.com/Mpratyush54/SERVER-automation/releases/latest/download/install.sh | sh
sudo platformctl recover
sudo platformctl update
```

`platformctl recover` uses local access inside the Postgres/Redis pods, resets the admin password to `ADMIN_PASSWORD` in `/etc/platform/.env`, patches Kubernetes secrets **in place** (it does not recreate `platform-env`), and restarts `platform-api`. It then prints the portal login.

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
