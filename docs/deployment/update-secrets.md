# Updating Kubernetes Secrets

Platform stores all environment configuration in a Kubernetes secret named `caps-platform-env` in the `caps` namespace (or `platform-env` in the `platform` namespace, depending on the deployment version). This document covers how to update those secrets and propagate changes.

---

## Secret Overview

The relevant secrets in the cluster:

| Secret | Namespace | Purpose |
|---|---|---|
| `platform-env` | `platform` | Platform API configuration (non-credential: domain, OIDC clients, JWT/encryption keys, webhook secret) |
| `platform-credentials` | `platform` | Admin and datastore credentials (`ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `MONGODB_URI`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`) plus rotation write-ahead copies (`*_PREV`, `*_NEXT`) |
| `platform-oidc-signing-key` | `platform` | Built-in OIDC provider signing key (`private.pem`, `kid`; `previous.pem` / `previous-kid` after a rotation) |
| `argocd-secret` | `argocd` | ArgoCD admin password |
| `platform-tls` | `platform` | Let's Encrypt TLS certificate |

### Where configuration lives (no host state)

The API reads configuration **only** from these Secrets. The Deployment has no
`hostPath` volume, so the pod can be rescheduled to any node and several
replicas sign OIDC tokens with the same key. The API may `get`/`update`
only the Secrets named above (RBAC `resourceNames`).

`/etc/platform/.env`, `/etc/platform/credentials/` and
`/etc/platform/oidc-signing-key.pem` are an operator-side, root-only
**break-glass copy**. platformctl refreshes it on `provision`, `update`,
`repair` and `recover`, and `recover` uses it when the cluster is unhealthy.
Rotating secrets from the portal updates the Secrets only; the next
`platformctl update` copies the new values back to the host.

**Upgrading an existing install:** `platformctl update` (or `provision`)
reads the live Secrets first and adopts any password rotated at runtime,
writes `platform-credentials`, seeds `platform-oidc-signing-key` from the old
`/etc/platform/oidc-signing-key.pem` (so existing SSO sessions stay valid),
removes the `hostPath` from the API Deployment, and only then removes the
credential keys from `platform-env`. No password changes. If the Secrets
cannot be read, the update stops before writing anything.

k3s runs with `secrets-encryption: true`, so these Secrets are encrypted at
rest. Secrets written before the upgrade are encrypted the next time they are
written; to re-encrypt everything at once run `sudo k3s secrets-encrypt reencrypt`.

Rotate the OIDC signing key (admin, password login) with
`POST /api/oauth/signing-key/rotate`. The previous key stays in JWKS until the
next rotation, and the API restarts so every replica loads the new key.

### Uploads and backups

Uploaded files go to the bundled MinIO bucket `platform-uploads`; database
backups without a configured storage provider go to the bucket
`platform-backups`. Point either at another S3-compatible store with
`UPLOADS_S3_ENDPOINT` / `UPLOADS_S3_ACCESS_KEY` / `UPLOADS_S3_SECRET_KEY` /
`UPLOADS_BUCKET` and `BACKUP_S3_ENDPOINT` / `BACKUP_S3_ACCESS_KEY` /
`BACKUP_S3_SECRET_KEY` / `BACKUP_BUCKET` in `platform-env`. Set
`UPLOADS_S3_PUBLIC_ENDPOINT` to an externally reachable S3 URL to also return
presigned PUT/GET URLs (`presignedUrl` from `POST /api/storage/upload-url`,
`GET /api/storage/file/:id?presigned=1`). The local-directory adapters are for
development only (`STORAGE_UPLOADS_BACKEND=local`, `BACKUP_STORAGE=local`).

---

## Method 1: `kubectl patch` with JSON Merge

This is the recommended approach for updating individual values.

### Create a Patch File

```bash
# Create patch.json with the values you want to change
cat > patch.json << 'EOF'
{
  "data": {
    "POSTGRES_PASSWORD": "bmV3LXBhc3N3b3JkLTEyMzQ=",
    "JWT_SECRET": "bmV3LWp3dC1zZWNyZXQ="
  }
}
EOF
```

### Base64 Encoding on Linux

```bash
echo -n "new-password-1234" | base64
# Output: bmV3LXBhc3N3b3JkLTEyMzQ=
```

### Base64 Encoding on Windows (PowerShell)

```powershell
# PowerShell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("new-password-1234"))
```

### Base64 Encoding on Windows (cmd)

```cmd
# Using certutil
echo new-password-1234 | certutil -encode - .\b64.tmp
type b64.tmp | findstr /v "BEGIN CERTIFICATE" | findstr /v "END CERTIFICATE" | findstr /v "^$"
del b64.tmp
```

> **Important:** `kubectl patch` with `--type merge` requires **base64-encoded values** in the `data` field. Use `stringData` instead if you want plaintext values (see below).

### Apply the Patch

```bash
# Using data (base64 encoded)
kubectl patch secret caps-platform-env -n caps \
  --type merge \
  -p "$(cat patch.json)"
```

### Simpler: Using `stringData` (plaintext)

`stringData` allows you to pass plaintext values and Kubernetes handles the encoding:

```bash
kubectl patch secret caps-platform-env -n caps --type merge -p '{
  "stringData": {
    "POSTGRES_PASSWORD": "new-password-1234",
    "JWT_SECRET": "new-jwt-secret-value"
  }
}'
```

---

## Method 2: Recreate the Secret

For bulk updates or when you want to replace the entire secret:

```bash
# Delete the existing secret
kubectl delete secret platform-env -n platform

# Recreate with new values
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=NODE_ENV=production \
  --from-literal=PORT=3000 \
  --from-literal=POSTGRES_PASSWORD="new-password-1234" \
  --from-literal=JWT_SECRET="new-jwt-secret" \
  --from-literal=DOMAIN="platform.example.com"
```

---

## Method 3: Update via Helm Values (for Helm-managed secrets)

If the secret is managed by a Helm chart, update the values file and re-run Helm:

```bash
helm upgrade --install postgresql bitnami/postgresql \
  --namespace databases \
  --set auth.postgresPassword="new-password-1234" \
  --wait
```

---

## Update `/etc/caps/.env` on Server

The bootstrap script generates a `.env` file on the server at `/etc/platform/.env`. You must also update this file for future re-runs of the bootstrap script:

```bash
# Edit the env file directly
sudo nano /etc/platform/.env

# Or update a specific value
sudo sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD='new-password-1234'/" /etc/platform/.env

# Secure the file
sudo chmod 600 /etc/platform/.env
```

---

## Restart Pods After Secret Change

Secrets are mounted as environment variables at pod startup. **Pods must be restarted** to pick up the new values.

### Restart via Rollout

```bash
# Restart all deployments in the platform namespace
kubectl rollout restart deployment -n platform

# Restart a specific deployment
kubectl rollout restart deployment/platform-api -n platform
kubectl rollout restart deployment/platform-portal -n platform
```

### Monitor the Restart

```bash
kubectl rollout status deployment/platform-api -n platform --timeout=300s
```

### Verify New Values in Running Pod

```bash
# Check the environment variable inside the running pod
kubectl exec -n platform deploy/platform-api -- env | grep POSTGRES_PASSWORD

# Or dump the secret to verify
kubectl get secret platform-env -n platform -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d
```

---

## Restart Pods Only (if deployment spec unchanged)

If you only changed the secret and the deployment spec is identical, `rollout restart` forces new pods:

```bash
kubectl rollout restart deployment -n platform
```

Alternatively, delete pods directly (deployment will recreate):

```bash
kubectl delete pod -n platform -l app=platform-api
kubectl delete pod -n platform -l app=platform-portal
```

---

## Full Workflow Example

```bash
# 1. Encode the new value
NEW_PASS=$(echo -n "my-new-password" | base64)
NEW_SECRET=$(echo -n "my-new-jwt-secret" | base64)

# 2. Apply the patch
kubectl patch secret platform-env -n platform --type merge -p "{
  \"data\": {
    \"POSTGRES_PASSWORD\": \"$NEW_PASS\",
    \"JWT_SECRET\": \"$NEW_SECRET\"
  }
}"

# 3. Verify the secret
kubectl get secret platform-env -n platform -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d

# 4. Update local env file
sudo sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD='my-new-password'/" /etc/platform/.env

# 5. Restart pods
kubectl rollout restart deployment/platform-api -n platform

# 6. Verify
kubectl rollout status deployment/platform-api -n platform --timeout=120s
kubectl exec -n platform deploy/platform-api -- env | grep POSTGRES_PASSWORD
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pod env not updated | Secret was changed but pod not restarted | Run `kubectl rollout restart` |
| `error: unable to decode` | Invalid JSON in patch | Validate with `echo '{"key":"val"}' \| python3 -m json.tool` |
| Secret value is garbled | Wrong base64 encoding | Use `echo -n` (not `echo`) to avoid trailing newline |
| `stringData` values not taking effect | Secret already exists with `immutable: true` | Check with `kubectl get secret platform-env -n platform -o yaml \| grep immutable` |
| Permission denied reading `/etc/platform/.env` | File permissions too open | `sudo chmod 600 /etc/platform/.env` |
