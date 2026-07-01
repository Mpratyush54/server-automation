# Secrets Management

The Platform secrets system provides AES-256-GCM encrypted storage for sensitive values (API keys, database passwords, tokens) with versioning, rollback, environment scoping, and full audit trails.

> **Architecture:** Secrets are stored in a dedicated `secrets` PostgreSQL table. Each value is encrypted at rest using the `SECRETS_ENCRYPTION_KEY` master key. See [Secrets Encryption](../api-reference/configuration/secrets-encryption.md) for cryptographic details.

---

## Creating Secrets

### Via API

```http
POST /api/projects/:projectId/secrets HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "key": "DATABASE_URL",
  "value": "postgresql://user:pass@host:5432/db",
  "environmentId": "development"           // optional — scope to environment
}
```

**Response:**

```json
{
  "id": "uuid",
  "key": "DATABASE_URL",
  "environmentId": "development",
  "version": 1
}
```

The plaintext value is encrypted on the server with AES-256-GCM before storage. The plaintext is **never persisted** — only the ciphertext (`iv:authTag:ciphertext`) is saved.

### Via Portal UI

1. Navigate to **Project → Secrets**
2. Click **Add Secret**
3. Enter key-value pair and select environment scope
4. Click **Save**

---

## Environment Scoping

Secrets can be scoped to a specific environment (development, staging, production, preview). This allows different values for the same key across environments.

```http
POST /api/projects/:projectId/secrets HTTP/1.1
{
  "key": "API_KEY",
  "value": "sk-dev-xxx",
  "environmentId": "development"
}

POST /api/projects/:projectId/secrets HTTP/1.1
{
  "key": "API_KEY",
  "value": "sk-prod-xxx",
  "environmentId": "production"
}
```

### Resolving Secrets by Environment

When fetching secrets, the `environmentId` field filters results. If `environmentId` is null/omitted, the secret is treated as global (available across all environments).

| `environmentId` | Behavior |
|---|---|
| `null` / omitted | Global secret — returned for all environments |
| Specific UUID | Only returned when that exact environment is queried |
| Environment name | Resolved to UUID automatically via lookup |

---

## Versioning and Rollback

### Version History

Every time a secret is updated, the **previous version** is archived to the `secret_versions` table before overwriting.

```http
GET /api/projects/:projectId/secrets/:secretId/versions
```

**Response:**

```json
{
  "key": "DATABASE_URL",
  "currentVersion": 5,
  "history": [
    { "version": 4, "changedById": "uuid", "changedAt": "2025-06-21T12:00:00Z" },
    { "version": 3, "changedById": "uuid", "changedAt": "2025-06-20T10:00:00Z" },
    { "version": 2, "changedById": "uuid", "changedAt": "2025-06-19T08:00:00Z" },
    { "version": 1, "changedById": null, "changedAt": "2025-06-18T06:00:00Z" }
  ]
}
```

### Rollback

```http
POST /api/projects/:projectId/secrets/:secretId/rollback/:version
```

Rollback restores the encrypted value from a previous version. The **current value is saved to history first** (so a rollback is itself a new version).

| Scenario | Version after rollback |
|---|---|
| Current is v5, rollback to v3 | v3's value is restored, version becomes v6 |
| Rollback to v2 again | v2 restored, version becomes v7 |

### Audit Trail

All secret operations are logged to the `audit_logs` table:

| Action | Logged |
|---|---|
| Create | `secrets.create` |
| Update | `secrets.update` |
| Reveal (decrypt) | `secrets.reveal` — includes key and environment |
| Delete (soft) | `secrets.delete` |
| Export | `secrets.export` — includes count of exported values |
| Import (bulk) | `secrets.import` — includes count |
| Rollback | `secrets.rollback` — includes source and target version |

---

## Bulk Import / Export

### Export as .env

```http
GET /api/projects/:projectId/secrets/export/:environmentId
Authorization: Bearer <token>
```

Requires `secrets.export` permission. Decrypts all secrets for the given environment and returns them as `.env` format:

```json
{
  "environmentId": "development",
  "secrets": "DATABASE_URL=postgresql://...\nAPI_KEY=sk-dev-xxx\nREDIS_URL=redis://..."
}
```

### Bulk Import

```http
POST /api/projects/:projectId/secrets/bulk
Authorization: Bearer <token>
Content-Type: application/json

{
  "environmentId": "production",
  "secrets": [
    { "key": "DATABASE_URL", "value": "postgresql://prod:xxx@host:5432/db" },
    { "key": "API_KEY", "value": "sk-prod-xxx" },
    { "key": "REDIS_URL", "value": "redis://:pass@host:6379" }
  ]
}
```

**Response:**

```json
{
  "imported": 3,
  "results": [
    { "key": "DATABASE_URL", "status": "updated", "version": 4 },
    { "key": "API_KEY", "status": "created", "version": 1 },
    { "key": "REDIS_URL", "status": "created", "version": 1 }
  ]
}
```

Requires `secrets.import` permission. Each item is individually encrypted and versioned.

---

## SDK Secret Injection

The Platform SDKs automatically inject secrets as environment variables into running services.

### How It Works

1. **SDK Registration** — When a service registers via the SDK (`POST /sdk/register`), it identifies itself with `projectName`, `environmentName`, and `envKeys` (the list of secret keys it needs).

2. **Config Fetch** — The SDK calls `GET /sdk/config?projectId=...&environmentId=...` on startup.

3. **Secret Resolution** — The API resolves the project name to UUID, finds the environment, and:
   - Reads `ProjectConfig` entries matching the environment
   - Decrypts `Secret` entries matching the environment
   - Returns all values as a flat JSON object

4. **Environment Variable Injection** — The SDK sets the returned key-value pairs as `process.env` (Node.js), `os.environ` (Python), etc.

### Node.js SDK Example

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

const client = new PlatformClient({
  token: 'sdk_live_your_project_token_here',
  projectName: 'my-app',
  environmentName: 'production',
});

await client.start();
// process.env now has DATABASE_URL, API_KEY, etc.
```

### Runtime Refresh

The SDK periodically re-fetches config (configurable interval, default 5 minutes) to pick up updated secrets without restarting the service.

### Required Permissions

For SDK token-based injection, the `SdkCredential` entity stores a token in format `sdk_live_<uuid>` or `sdk_test_<uuid>`. These tokens have access to secrets belonging to the project they were created for — no additional RBAC check is performed (the token itself IS the authorization).

```http
POST /api/projects/:projectId/tokens
Authorization: Bearer <token>
{ "name": "production-token" }

→ 201 { "token": "sdk_live_abc123def456..." }
```

> The plaintext token is returned **only once** at creation time. Store it securely.
