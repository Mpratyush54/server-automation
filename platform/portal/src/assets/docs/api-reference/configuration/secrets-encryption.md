# Secrets Encryption

## Algorithm

Platform uses **AES-256-GCM** (Galois/Counter Mode) for secret encryption at rest.

| Parameter | Value |
|---|---|
| Algorithm | `aes-256-gcm` |
| Key size | 256 bits (32 bytes) |
| IV size | 128 bits (16 bytes) |
| Auth tag | 128 bits (16 bytes) |
| Mode | GCM (authenticated encryption) |

### Encryption Format

Encrypted values are stored as a colon-delimited string:

```
{iv_hex}:{auth_tag_hex}:{ciphertext_hex}
```

Example:

```
a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2:3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4
```

| Segment | Length (hex) | Description |
|---|---|---|
| IV | 32 chars (16 bytes) | Random initialization vector per encryption |
| Auth tag | 32 chars (16 bytes) | GCM authentication tag |
| Ciphertext | Variable | AES-256-GCM encrypted payload |

### Derivation

The master key (`SECRETS_ENCRYPTION_KEY`) is **SHA-256 hashed** to derive the actual AES key:

```typescript
// platform/api/src/lib/secrets-encryption.ts:7-9
function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest();
}
```

This allows the master key to be any length (the user provides it as base64 or hex, SHA-256 normalizes it to 32 bytes).

---

## Key Generation

### 32-byte Hex Key

```bash
openssl rand -hex 32
```

Example output: `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2`

### 32-byte Base64 Key

```bash
openssl rand -base64 32
```

### Setting the Key

```bash
# In platform/api/.env (local development)
SECRETS_ENCRYPTION_KEY=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2

# In Kubernetes Secret
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=SECRETS_ENCRYPTION_KEY="$SECRETS_ENCRYPTION_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

## Key Rotation Procedure

### 1. Generate a New Key

```bash
NEW_KEY=$(openssl rand -hex 32)
```

### 2. Re-encrypt All Secrets

There is no built-in re-encryption command. The procedure is:

```bash
# Export all secrets per project/environment
# (requires secrets.export permission for each)
for env in development staging production; do
  curl -H "Authorization: Bearer $TOKEN" \
    "https://$DOMAIN/api/projects/$PROJECT_ID/secrets/export/$env" \
    | jq -r '.secrets' > "secrets-$env.env"
done
```

### 3. Update the Key

```bash
# Update .env file
sed -i "s/SECRETS_ENCRYPTION_KEY=.*/SECRETS_ENCRYPTION_KEY=$NEW_KEY/" .env

# Update Kubernetes Secret
kubectl delete secret platform-env -n platform
kubectl create secret generic platform-env \
  --namespace platform \
  --from-literal=SECRETS_ENCRYPTION_KEY="$NEW_KEY" \
  # ... all other env vars
```

### 4. Re-import Secrets

```bash
# Bulk import each environment's secrets with the new key
for env in development staging production; do
  curl -X POST -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"environmentId\": \"$env\",
      \"secrets\": $(cat "secrets-$env.env" | jq -R -s -c 'split("\n") | map(select(length > 0) | split("=") | {key: .[0], value: .[1:] | join("=")})')
    }" \
    "https://$DOMAIN/api/projects/$PROJECT_ID/secrets/bulk"
done
```

### 5. Verify

```bash
# Reveal a test secret to confirm decryption works
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"key":"TEST_SECRET","environmentId":"development"}' \
  "https://$DOMAIN/api/projects/$PROJECT_ID/secrets/reveal"
```

### Downtime Consideration

During rotation, there is a brief window where the old key is removed but secrets haven't been re-encrypted yet. To avoid this:

1. **Stage 1:** Deploy new key alongside old key (read with old, write with new) — not currently supported
2. **Stage 2:** Export secrets before updating the key (as shown above)
3. **Stage 3:** Update key, import secrets — brief unavailability if done during traffic

---

## Performance Considerations

### Encryption Overhead

| Operation | Approximate Time (development) |
|---|---|
| Encrypt 100-byte value | < 1 ms |
| Decrypt 100-byte value | < 1 ms |
| Bulk import 100 secrets | ~50-100 ms |
| Export 100 secrets | ~100-200 ms |

Encryption is performed synchronously in the request path. For bulk operations, each secret is encrypted/decrypted individually.

### Database Storage

- Encrypted values in the `secrets.encrypted_value` column are ~2.7x the original plaintext size (hex encoding + IV + auth tag).
- Historical versions are stored in `secret_versions` — plan for storage growth based on update frequency.

### Audit Logging

Each `secrets.reveal` operation is audit-logged. Frequent decryption of secrets (e.g., in a tight loop) will generate many audit log entries. Use the SDK config endpoint for programmatic access instead of repeated reveal calls.
