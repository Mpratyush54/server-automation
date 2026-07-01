# Secrets Architecture

## Encryption at Rest — AES-256-GCM

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SECRETS_ENCRYPTION_KEY                          │
│                     (32 bytes hex = 64 chars)                      │
│                          │                                          │
│                          ▼                                          │
│     crypto.createHash('sha256').update(masterKey).digest()         │
│                          │                                          │
│                    ┌─────┴─────┐                                    │
│                    │ 256-bit   │                                    │
│                    │ AES key   │                                    │
│                    └─────┬─────┘                                    │
│                          │                                          │
│              ┌───────────┴───────────┐                              │
│              │                       │                              │
│              ▼                       ▼                              │
│     ┌────────────────┐     ┌────────────────┐                      │
│     │  encryptValue  │     │  decryptValue  │                      │
│     │                │     │                │                      │
│     │  randomBytes(  │     │  split(":") →  │                      │
│     │    16) = iv    │     │  iv + authTag  │                      │
│     │                │     │  + ciphertext  │                      │
│     │  cipher =      │     │                │                      │
│     │  createCipheriv│     │  decipher =    │                      │
│     │  (aes-256-gcm, │     │  createDecipher│                      │
│     │   key, iv)     │     │  iv(aes-256-   │                      │
│     │                │     │  gcm, key, iv) │                      │
│     │  output =      │     │                │                      │
│     │  iv:authTag:   │     │  setAuthTag(   │                      │
│     │  ciphertext    │     │    authTag)     │                      │
│     │  (hex)         │     │                │                      │
│     └────────────────┘     └───────┬────────┘                      │
│                                    │                                │
│                                    ▼                                │
│                     ┌──────────────────────────┐                   │
│                     │  Plaintext string        │                   │
│                     └──────────────────────────┘                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Code** (`src/lib/secrets-encryption.ts`):
```typescript
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;       // 128-bit initialization vector
const AUTH_TAG_LENGTH = 16; // 128-bit GCM authentication tag

function deriveKey(masterKey: string): Buffer {
  return crypto.createHash('sha256').update(masterKey).digest();
}

export function encryptValue(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptValue(encryptedPayload: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payload format');
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

## Storage Format

The encrypted blob stored in PostgreSQL `secrets.encrypted_value`:
```
{iv_hex}:{auth_tag_hex}:{ciphertext_hex}
  │           │              │
  │           │              └── AES-256-GCM encrypted payload (hex)
  │           └── GCM authentication tag (32 hex chars = 16 bytes)
  └── Random initialization vector (32 hex chars = 16 bytes)
```

Example: `a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d:4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f`

## Database Schema

### Secret Entity (`src/entities/Secret.ts`)

```typescript
@Entity('secrets')
export class Secret {
  id: string;                            // UUID primary key
  projectId: string;                     // UUID — FK to projects.id
  environmentId: string | null;          // UUID — FK to environments.id (null = global)
  key: string;                           // e.g. "DATABASE_URL", "API_KEY"
  encryptedValue: string;                // iv:authTag:ciphertext format
  version: number;                       // integer, starts at 1
  createdById: string | null;            // UUID — user who created/updated
  isActive: boolean;                     // soft delete flag
  createdAt: Date;
  updatedAt: Date;
}
```

### SecretVersion Entity (`src/entities/SecretVersion.ts`)

```typescript
@Entity('secret_versions')
export class SecretVersion {
  id: string;                            // UUID primary key
  secretId: string;                      // UUID — FK to secrets.id (CASCADE delete)
  encryptedValue: string;                // Previous encrypted value
  version: number;                       // The version number being archived
  changedById: string | null;            // UUID — user who made the change
  createdAt: Date;
}
```

## API Endpoints

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SECRETS API ROUTES                             │
│                      /api/projects/:projectId/secrets              │
│                                                                     │
│  GET    /                           → List secrets (masked values) │
│  POST   /                           → Create/update secret         │
│  POST   /reveal                     → Reveal plaintext value       │
│  DELETE /:secretId                  → Soft-delete secret           │
│  GET    /export/:environmentId      → Export as .env format        │
│  POST   /bulk                       → Bulk import from JSON       │
│  GET    /:secretId/versions         → Version history              │
│  POST   /:secretId/rollback/:version→ Rollback to previous version │
└─────────────────────────────────────────────────────────────────────┘
```

### Required Permissions per Endpoint

| Endpoint | Permission | Description |
|----------|-----------|-------------|
| `GET /` | `secrets.list` | View masked secret metadata |
| `POST /` | `secrets.create` | Create new or update existing secret |
| `POST /reveal` | `secrets.reveal` | View plaintext value (audit-logged) |
| `DELETE /:id` | `secrets.delete` | Soft delete |
| `GET /export` | `secrets.export` | Export all secrets as `.env` (devops only) |
| `POST /bulk` | `secrets.import` | Bulk import from JSON (devops only) |
| `GET /versions` | `secrets.list` | View version history |
| `POST /rollback` | `secrets.rollback` | Rollback to previous version |

## Versioning Flow

```
                      ┌──────────────┐
                      │  Secret v1   │
                      │  value="abc" │
                      └──────┬───────┘
                             │ PATCH /secrets { value: "xyz" }
                             ▼
         ┌──────────────────────────────────┐
         │  Step 1: Archive current version │
         │  SecretVersion.create({          │
         │    secretId,                     │
         │    encryptedValue: v1 encrypted, │
         │    version: 1,                   │
         │    changedById: userId           │
         │  })                              │
         └──────────────────────────────────┘
         │
         ▼
         ┌──────────────────────────────────┐
         │  Step 2: Update secret           │
         │  Secret.update({                 │
         │    encryptedValue: "xyz" enc,    │
         │    version: 2,                   │
         │    createdById: userId           │
         │  })                              │
         └──────────────────────────────────┘
         │
         ▼
                      ┌──────────────┐
                      │  Secret v2   │
                      │  value="xyz" │
                      └──────┬───────┘
                             │ POST /rollback/:version1
                             ▼
         ┌──────────────────────────────────┐
         │  Step 1: Archive current v2      │
         │  SecretVersion.create({ v2 enc })│
         ├──────────────────────────────────┤
         │  Step 2: Restore v1 encrypted    │
         │  Secret.encryptedValue = v1.enc  │
         │  Secret.version = 3              │
         └──────────────────────────────────┘
         │
         ▼
                      ┌──────────────┐
                      │  Secret v3   │
                      │  value="abc" │  (rolled back to v1 content)
                      └──────────────┘
```

**Key observations:**
- Rollback creates a new version (increment), it does not revert the version counter
- Previous encrypted values are preserved in `secret_versions` for audit trail
- CASCADE delete: removing a `Secret` deletes all associated `SecretVersion` rows

## Audit Trail

All secret access is logged to the `audit_logs` table:

```typescript
// Every secret mutation logs:
await logAudit({
  userId: req.user?.id,
  action: 'secrets.create' | 'secrets.update' | 'secrets.delete'
        | 'secrets.reveal' | 'secrets.export' | 'secrets.import'
        | 'secrets.rollback',
  targetType: 'Secret',
  targetId: secret.id,
  metadata: { key, environmentId, version },
  ip: req.ip,
});
```

| Action | When |
|--------|------|
| `secrets.create` | New key created (version === 1) |
| `secrets.update` | Existing key updated (version > 1) |
| `secrets.delete` | Soft delete (`isActive = false`) |
| `secrets.reveal` | Plaintext viewed (high-sensitivity) |
| `secrets.export` | Bulk export as `.env` |
| `secrets.import` | Bulk import from JSON |
| `secrets.rollback` | Rollback to previous version |

## Export/Import

### Export (plaintext JSON — devops only)

`GET /api/projects/:projectId/secrets/export/:environmentId`

```json
{
  "environmentId": "env-uuid",
  "secrets": "DATABASE_URL=postgres://...\nAPI_KEY=sk-...\nREDIS_PASSWORD=..."
}
```

- Requires `secrets.export` permission (only `admin` and `devops` roles)
- All secrets for the given environment are decrypted and concatenated as `.env` format
- Audit-logged with count of exported secrets

### Import (bulk create from JSON)

`POST /api/projects/:projectId/secrets/bulk`

```json
{
  "environmentId": "env-uuid",
  "secrets": [
    { "key": "DATABASE_URL", "value": "postgres://..." },
    { "key": "API_KEY", "value": "sk-..." }
  ]
}
```

- Requires `secrets.import` permission (only `admin` and `devops` roles)
- Each item is encrypted individually and stored
- Existing keys are updated (new version created), new keys are created
- Returns status per key: `{ key: "DATABASE_URL", status: "created" | "updated", version: 1 }`

## Scoping

Secrets are namespaced hierarchically:

```
Projects
└── Environments
    └── Secrets
        └── Versions
```

- **Per-project**: All secrets within a project scope (`projectId` is required)
- **Per-environment**: Optional environment scoping (`environmentId` nullable)
  - `environmentId = null` → global/fallback secret
  - `environmentId = 'uuid'` → environment-specific secret (overrides global)
- **Per-key**: Unique per (projectId, environmentId, key) combination
- **Soft-delete**: `isActive = false` rather than hard delete

### Resolution Order

When SDK requests config via `GET /api/sdk/config?projectId=X&environmentId=Y`:

1. Query `ProjectConfig` table for project+environment key-value pairs
2. Query `Secret` table for all active secrets in project+environment
3. Decrypt each `encryptedValue` with `SECRETS_ENCRYPTION_KEY`
4. Return merged result (secrets override config if same key)

```typescript
// src/routes/sdk.ts:453-465
const allSecrets = await secretRepo.find({
  where: { projectId: resolvedProjectId, isActive: true },
});
for (const s of allSecrets) {
  if (s.environmentId && environmentId && s.environmentId !== environmentId) continue;
  result[s.key] = decryptValue(s.encryptedValue, masterKey);
}
```

## Security Considerations

| Aspect | Implementation |
|--------|---------------|
| **Encryption algorithm** | AES-256-GCM (authenticated encryption with associated data) |
| **Key derivation** | SHA-256 hash of `SECRETS_ENCRYPTION_KEY` env var |
| **IV** | Random 16 bytes per encryption — ensures ciphertext uniqueness |
| **Authentication tag** | 16-byte GCM tag — detects tampering |
| **Key storage** | Environment variable only (not in database) |
| **In-transit** | TLS via ingress-nginx (cert-manager + Let's Encrypt) |
| **At-rest (DB)** | Encrypted `encrypted_value` column; key not in database |
| **Access control** | RBAC — `secrets.reveal` restricted to admin/devops/tech_lead |
| **Audit** | Every reveal, create, update, delete, export, rollback logged |
| **Versioning** | Previous encrypted values preserved in `secret_versions` |
| **Soft delete** | `isActive = false` — values remain in database for recovery |

> See [Auth Flow](auth-flow.md) for RBAC details and [SDK Lifecycle](sdk-lifecycle.md) for how SDKs fetch secrets at init time.
