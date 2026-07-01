# Secrets API

Manage encrypted secrets with version history, rollback, and bulk import/export.

All secret values are encrypted at rest using AES-256-GCM with a master key (`SECRETS_ENCRYPTION_KEY` environment variable).

---

## `GET` /api/projects/:projectId/secrets

Lists all active secrets for a project. Values are masked (`***`). Requires `secrets.list` permission.

**Auth:** Bearer token (`secrets.list` permission)

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "key": "DATABASE_URL",
    "environmentId": "uuid-or-null",
    "version": 3,
    "maskedValue": "***",
    "createdById": "uuid",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-07-01T12:00:00.000Z"
  }
]
```

---

## `POST` /api/projects/:projectId/secrets

Creates or updates a secret. If a secret with the same `key` and `environmentId` exists, the previous version is saved to history and the version is incremented. Requires `secrets.create` permission. Audit-logged.

**Auth:** Bearer token (`secrets.create` permission)

**Request Body:**
```json
{
  "key": "DATABASE_URL",
  "value": "postgresql://user:pass@host:5432/db",
  "environmentId": "uuid-or-null"
}
```

**Response `201`:**
```json
{
  "id": "uuid",
  "key": "DATABASE_URL",
  "environmentId": "uuid",
  "version": 3
}
```

---

## `POST` /api/projects/:projectId/secrets/reveal

Reveals a secret's plaintext value. This action is audit-logged with the key and environment. Requires `secrets.reveal` permission.

**Auth:** Bearer token (`secrets.reveal` permission)

**Request Body:**
```json
{
  "environmentId": "uuid",
  "key": "DATABASE_URL"
}
```

**Response `200`:**
```json
{
  "id": "uuid",
  "key": "DATABASE_URL",
  "value": "postgresql://user:pass@host:5432/db",
  "environmentId": "uuid",
  "version": 3
}
```

**Error `500`:**
```json
{ "error": "SECRETS_ENCRYPTION_KEY not configured" }
```

---

## `DELETE` /api/projects/:projectId/secrets/:secretId

Soft-deletes a secret by setting `isActive = false`. Requires `secrets.delete` permission. Audit-logged.

**Auth:** Bearer token (`secrets.delete` permission)

**Response `200`:**
```json
{ "success": true }
```

---

## `GET` /api/projects/:projectId/secrets/export/:environmentId

Exports all secrets for an environment as a `.env`-formatted string. Values are decrypted before export. Requires `secrets.export` permission. Audit-logged.

**Auth:** Bearer token (`secrets.export` permission)

**Response `200`:**
```json
{
  "environmentId": "uuid",
  "secrets": "DATABASE_URL=postgresql://user:pass@host:5432/db\nAPI_KEY=sk-abc123\n"
}
```

---

## `POST` /api/projects/:projectId/secrets/bulk

Bulk imports secrets as an array of `{key, value}` objects. Existing keys are updated with incremented versions; new keys are created. Requires `secrets.import` permission. Audit-logged.

**Auth:** Bearer token (`secrets.import` permission)

**Request Body:**
```json
{
  "environmentId": "uuid",
  "secrets": [
    { "key": "DATABASE_URL", "value": "postgresql://..." },
    { "key": "API_KEY", "value": "sk-abc123" }
  ]
}
```

**Response `201`:**
```json
{
  "imported": 2,
  "results": [
    { "key": "DATABASE_URL", "status": "updated", "version": 4 },
    { "key": "API_KEY", "status": "created", "version": 1 }
  ]
}
```

---

## Version History

### `GET` /api/projects/:projectId/secrets/:secretId/versions

Returns the version history for a secret. Requires `secrets.list` permission.

**Response `200`:**
```json
{
  "key": "DATABASE_URL",
  "currentVersion": 4,
  "history": [
    { "version": 3, "changedById": "uuid", "changedAt": "2026-06-01T00:00:00.000Z" },
    { "version": 2, "changedById": "uuid", "changedAt": "2026-05-01T00:00:00.000Z" },
    { "version": 1, "changedById": "uuid", "changedAt": "2026-04-01T00:00:00.000Z" }
  ]
}
```

---

## Rollback

### `POST` /api/projects/:projectId/secrets/:secretId/rollback/:version

Rolls back a secret to a previous version. The current version is saved to history first, then the target version's encrypted value is restored. The version counter is incremented. Requires `secrets.rollback` permission. Audit-logged.

**Auth:** Bearer token (`secrets.rollback` permission)

**Response `200`:**
```json
{
  "success": true,
  "key": "DATABASE_URL",
  "version": 5,
  "rolledBackTo": 2
}
```

**Error `400`:**
```json
{ "error": "Version 5 is not a previous version (current: 6)" }
```

---

## Error Codes

| Status | Error                                   | Description                         |
|--------|-----------------------------------------|-------------------------------------|
| 400    | `key and value are required`            | Missing fields on create            |
| 400    | `Invalid version number`                | Rollback version is not a number    |
| 400    | `secrets must be a non-empty array...`  | Invalid bulk import payload         |
| 404    | `Secret not found`                      | Secret does not exist               |
| 404    | `Version X not found in history`        | Target version does not exist       |
| 500    | `SECRETS_ENCRYPTION_KEY not configured` | Missing encryption key environment variable |
| 500    | `Failed to decrypt secret`              | Encryption/decryption error         |

---

## Related

- [Secrets Encryption Architecture](/docs/architecture/secrets-architecture)
- [Secrets Management Guide](/docs/guides/secrets-management)
- [Permissions Configuration](/docs/api-reference/configuration/permissions)
