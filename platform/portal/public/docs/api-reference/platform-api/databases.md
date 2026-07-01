# Databases API

Provision PostgreSQL databases, manage database connections, and handle backups.

---

## `POST` /api/projects/:id/databases/provision

Provisions a new PostgreSQL database for a project environment. Returns the connection credentials **once** — the password will not be shown again. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Request Body:**
```json
{
  "environment": "staging"
}
```

**Response `201`:**
```json
{
  "dbName": "my-app-staging",
  "username": "my_app_staging_user",
  "password": "generated-password",
  "host": "postgres-service.databases.svc.cluster.local",
  "port": 5432,
  "connectionString": "postgresql://my_app_staging_user:generated-password@postgres-service.databases.svc.cluster.local:5432/my-app-staging",
  "message": "Database provisioned. Save these credentials — the password will not be shown again."
}
```

---

## Database Connections

### `GET` /api/db-connections

Lists database connections. Can be filtered by `projectId` query parameter.

**Auth:** Bearer token (any authenticated user)

**Query Parameters:**
| Param     | Type | Description            |
|-----------|------|------------------------|
| projectId | uuid | Filter by project      |

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "projectId": "uuid",
    "dbType": "postgres",
    "poolSize": 10,
    "status": "connected",
    "activeCount": 2,
    "idleCount": 8,
    "lastHeartbeat": "2026-07-01T12:00:00.000Z"
  }
]
```

**DbType values:** `postgres`, `mongo`, `redis`
**Status values:** `connected`, `degraded`, `disconnected`

### `POST` /api/db-connections

Creates a new database connection record. Requires DEVOPS role.

**Auth:** Bearer token (DEVOPS)

**Request Body:**
```json
{
  "projectId": "uuid",
  "dbType": "postgres",
  "poolSize": 20
}
```

**Response `201`:**
```json
{
  "id": "uuid",
  "projectId": "uuid",
  "dbType": "postgres",
  "poolSize": 20,
  "status": "connected",
  "lastHeartbeat": "2026-07-01T12:00:00.000Z"
}
```

### `POST` /api/db-connections/:id/test

Tests a database connection by updating its status and simulating latency.

**Auth:** Bearer token (any authenticated user)

**Response `200`:**
```json
{
  "status": "connected",
  "latencyMs": 12
}
```

### `DELETE` /api/db-connections/:id

Deletes a database connection record. Requires DEVOPS role.

**Auth:** Bearer token (DEVOPS)

**Response `200`:**
```json
{ "success": true }
```

---

## Database Backups

### `POST` /api/projects/:projectId/databases/backup

Triggers an asynchronous database backup using `pg_dump`. The backup is uploaded to the active storage provider. An SMTP notification is sent to DEVOPS users on completion. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Request Body:**
```json
{
  "dbName": "my-app-production",
  "environment": "production"
}
```

**Response `202`:**
```json
{
  "backupId": "uuid",
  "status": "in_progress",
  "message": "Backup started. You will be notified when complete."
}
```

### `GET` /api/projects/:projectId/databases/backups

Lists backups for a project. Can be filtered by `dbName` query parameter.

**Auth:** Bearer token (any authenticated user)

**Query Parameters:**
| Param  | Type   | Description            |
|--------|--------|------------------------|
| dbName | string | Filter by database name|

**Backup Statuses:** `pending`, `in_progress`, `completed`, `failed`, `restoring`

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "projectId": "uuid",
    "dbName": "my-app-production",
    "environment": "production",
    "providerType": "minio",
    "fileId": "backups/my-app/my-app-production/dump_...",
    "fileSizeBytes": 1048576,
    "checksum": "sha256-checksum",
    "status": "completed",
    "createdAt": "2026-07-01T12:00:00.000Z"
  }
]
```

### `POST` /api/projects/:projectId/databases/backups/:backupId/restore

Restores a database from a completed backup. Downloads the backup file from the storage provider and runs `pg_restore`. Requires DEVOPS role. Audit-logged.

**Auth:** Bearer token (DEVOPS)

**Response `202`:**
```json
{
  "message": "Restore started",
  "backupId": "uuid"
}
```

**Error `400`:**
```json
{ "error": "Backup is not in completed state" }
```

---

## Error Codes

| Status | Error                                    | Description                           |
|--------|------------------------------------------|---------------------------------------|
| 400    | `environment is required`                | Missing environment on provision      |
| 400    | `dbName is required`                     | Missing dbName on backup              |
| 400    | `Backup is not in completed state`       | Cannot restore an incomplete backup   |
| 404    | `Project not found`                      | Invalid projectId                     |
| 404    | `DB Connection not found`                | Invalid connection ID                 |

---

## Related

- [Projects API](projects.md)
- [Secrets API](secrets.md)
- [Files API](files.md)
