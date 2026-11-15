# Rotate Cairn's own passwords

This page helps you replace the passwords Cairn itself uses, for example after someone leaves the team. Open **Settings** in the sidebar and choose the **Rotate secrets** tab. You need the DevOps or admin role.

This is about Cairn's own passwords. To change your app's secrets, see [Store secrets and settings for your app](../guides/secrets-management.md).

## Rotate from the portal

1. Open **Settings** and choose **Rotate secrets**.
2. Type `ROTATE` in the box.
3. Choose **Rotate all secrets**. You are asked for a fresh two-factor code.
4. Copy the new values into a password manager. They are shown **once**.

A progress panel shows each step. When it finishes, each item shows **Rotated** or **Failed**. The API restarts by itself at the end.

Then, on the server, refresh the backup copy of the passwords:

```bash
sudo platformctl update
```

### If the page lost the new values

If the page shows an error such as `502` or loses the connection, the rotation may still have finished. The new admin password is saved in the cluster (Secret `platform/platform-credentials`). To read it, run on the server:

```bash
sudo platformctl update
sudo cat /etc/platform/credentials/admin
```

Check the progress panel before you rotate again.

## What gets rotated

| Rotated | Not rotated |
|---|---|
| Cairn admin password | MongoDB password |
| PostgreSQL password | File-storage keys |
| Redis password | Portainer password |
| Webhook secret | `JWT_SECRET` |
| Argo CD admin password | `SECRETS_ENCRYPTION_KEY` |

MongoDB, file storage and Portainer are left alone so the API never restarts with a password those services would reject.

On the high-availability install (Redis with Sentinel), the portal rotates every data node and Sentinel live, without restarting Redis. Project ACL users keep working. The Redis Secret and platform credentials are updated after all members have changed; the chart reads the Secret again on restart. Runtime configuration is persisted where writable.

The old Redis password keeps working for about three minutes after the rotation. Redis health checks read the password from the Redis Secret, and Kubernetes takes a minute or two to give pods the new copy. A follow-up step (`platform.redis-password-drop`) then removes the old password, including the old Sentinel discovery password. It survives API restarts and does nothing if a newer rotation has already replaced the password. Connected apps stay connected. An app that uses Sentinel discovery gets the new discovery password when it restarts and the SDK registers again; restart such apps after a rotation so a later reconnect does not fail.

If an HA Redis rotation is interrupted, retry **Rotate all secrets**. Cairn retains the pending password pair and checks each member with both passwords before continuing. Keep the pending credentials until rotation succeeds; a reachable master alone does not mean every member has rotated.

## If something goes wrong

If PostgreSQL or Redis rejects the new password, the API tries every stored copy and fixes the cluster secrets by itself. You do not need SSH for this.

If the API still cannot start, or you cannot sign in as admin, run on the server:

```bash
sudo platformctl recover
sudo platformctl update
```

See [Database auth errors after rotating passwords](../troubleshooting/db-wrongpass-after-rotate.md) and [Recover](../operations/recover.md).

## Rotate the sign-in signing key

The key that signs sign-in tokens for Grafana, Argo CD and the other bundled tools can be rotated by an admin through the API (see [For developers / API](#for-developers--api); it needs a password sign-in, not an agent token). The previous key keeps working until the next rotation, and the API restarts so every replica loads the new key.

## How it works

### Where Cairn's settings live

All of Cairn's settings are Kubernetes secrets. A secret here means a Kubernetes object that stores values for pods.

| Secret | Namespace | Holds |
|---|---|---|
| `platform-env` | `platform` | Settings that are not passwords: domain, sign-in clients, JWT and encryption keys, webhook secret |
| `platform-credentials` | `platform` | `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MONGODB_URI`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, plus `*_PREV` / `*_NEXT` copies written during a rotation |
| `platform-oidc-signing-key` | `platform` | Signing key for the built-in sign-in provider (`private.pem`, `kid`; `previous.pem` / `previous-kid` after a rotation) |
| `argocd-secret` | `argocd` | Argo CD admin password |
| `platform-tls` | `platform` | HTTPS certificate |

The API reads its settings only from these secrets. It has no folder mounted from the host, so the pod can run on any node, and several replicas share one signing key. The API may only read and update the secrets it needs.

`/etc/platform/.env`, `/etc/platform/credentials/` and `/etc/platform/oidc-signing-key.pem` are a root-only backup copy on the server. platformctl refreshes it on `provision`, `update`, `repair` and `recover`. `recover` uses it when the cluster is unhealthy. Rotating from the portal updates the cluster secrets only; the next `platformctl update` copies the new values to the server.

k3s runs with `secrets-encryption: true`, so these secrets are encrypted at rest. Secrets written before that was turned on are encrypted the next time they are written. To re-encrypt everything at once, run `sudo k3s secrets-encrypt reencrypt`.

### Rotation steps

The rotation runs as a tracked operation (`platform/api/src/lib/secret-rotate.ts`). Each step can be safely re-run after a crash:

1. **admin-password** — the new admin password is hashed into every admin user.
2. **write-ahead** — the previous and next datastore passwords are written to `platform-credentials` and to `platform-rotate-pending`. If neither can be written, the rotation stops and no datastore password changes.
3. **redis-password** — the Redis password is changed. On HA installs the old one stays valid for now.
4. **schedule-redis-drop** — HA only: schedules the follow-up that removes the old Redis password about three minutes later, once pods have the new Secret.
5. **postgres-password** — the PostgreSQL password is changed and the API reconnects.
6. **patch-secrets** — the webhook secret in `platform-env`, and the `postgresql` and `redis` secrets in `databases`, are updated.
7. **argocd-password** — `argocd-secret` and `argocd-initial-admin-secret` are updated.
8. **finalize** — `platform-rotate-pending` is cleared when both datastores rotated, and admins and DevOps users get a notification.
9. **restart-api** — the API deployment restarts. This step is not repeated after a crash.

When the API starts, it also checks which stored password works and syncs the secrets to it.

### Upgrading an older install

`platformctl update` (or `provision`) reads the live secrets first and keeps any password rotated at runtime. It writes `platform-credentials`, seeds `platform-oidc-signing-key` from the old `/etc/platform/oidc-signing-key.pem` (so SSO sessions stay valid), removes the host folder from the API deployment, and only then removes the password keys from `platform-env`. No password changes. If the secrets cannot be read, the update stops before writing anything.

### Change a setting by hand

For settings that are not passwords (in `platform-env`), patch the secret with plain values and restart the API:

```bash
kubectl patch secret platform-env -n platform --type merge -p '{
  "stringData": { "SOME_SETTING": "new-value" }
}'
kubectl rollout restart deployment/platform-api -n platform
kubectl rollout status deployment/platform-api -n platform --timeout=300s
```

Pods read secrets when they start, so a restart is needed.

> [!WARNING]
> Do not change `POSTGRES_PASSWORD`, `REDIS_PASSWORD` or other datastore passwords by editing a secret. That changes the copy the API uses, not the password on the database, and the API stops connecting. Use **Rotate secrets** or `platformctl recover` instead.

Do not change `SECRETS_ENCRYPTION_KEY` either: values already encrypted with the old key can no longer be read.

### Uploads and backups storage

Uploaded files go to the bundled file storage, bucket `platform-uploads`. Database backups without a configured storage provider go to the bucket `platform-backups`. To use another S3-compatible store, set these in `platform-env`:

- Uploads: `UPLOADS_S3_ENDPOINT`, `UPLOADS_S3_ACCESS_KEY`, `UPLOADS_S3_SECRET_KEY`, `UPLOADS_BUCKET` (and optionally `UPLOADS_S3_REGION`).
- Backups: `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_BUCKET` (and optionally `BACKUP_S3_REGION`).

Set `UPLOADS_S3_PUBLIC_ENDPOINT` to an S3 address reachable from outside to also get presigned upload and download links (`presignedUrl` from `POST /api/storage/upload-url`, and `GET /api/storage/file/:id?presigned=1`). The local-folder options (`STORAGE_UPLOADS_BACKEND=local`, `BACKUP_STORAGE=local`) are for development only.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A pod still uses the old value | The secret changed but the pod was not restarted | `kubectl rollout restart deployment/<name> -n platform` |
| `error: unable to decode` | Invalid JSON in the patch | Check the JSON, for example with `python3 -m json.tool` |
| A value looks garbled | Wrong base64 when using `data` | Use `stringData` with plain values, or `echo -n` when encoding |
| API cannot reach PostgreSQL or Redis after a manual edit | The secret and the database disagree | `sudo platformctl recover`, then `sudo platformctl update` |

## For developers / API

`POST /api/settings/rotate-secrets` with `{ "confirm": "ROTATE" }`. Needs the DevOps or admin role and a fresh two-factor code. It answers `409` while another rotation runs. The answer holds `results` (one `{ key, ok, detail }` per item), `values` (the new passwords, shown once), `operationId` and `status`.

`POST /api/oauth/signing-key/rotate` (admin, password session) answers `{ kid, previousKidRetained: true }`.
