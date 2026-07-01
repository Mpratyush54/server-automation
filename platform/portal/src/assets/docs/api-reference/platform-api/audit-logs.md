# Audit Logs API

View audit logs for all user actions and search application logs.

---

## `GET` /api/audit-logs

Returns the 100 most recent audit log entries, ordered by timestamp descending. Requires DEVOPS or TECH_LEAD role.

Audit logs track actions such as user creation, project updates, deployments, secret access, and role changes.

**Auth:** Bearer token (DEVOPS, TECH_LEAD)

**Response `200`:**
```json
[
  {
    "id": "uuid",
    "userId": "uuid",
    "action": "project.created",
    "targetType": "Project",
    "targetId": "uuid",
    "metadata": {},
    "ipAddress": "192.168.1.100",
    "performedAt": "2026-07-01T12:00:00.000Z"
  },
  {
    "id": "uuid",
    "userId": "uuid",
    "action": "user.invited",
    "targetType": "User",
    "targetId": "uuid",
    "metadata": {
      "email": "newuser@dev.io",
      "role": "developer"
    },
    "ipAddress": "192.168.1.100",
    "performedAt": "2026-07-01T11:59:00.000Z"
  }
]
```

---

## `GET` /api/logs/search

Searches application logs stored in MongoDB. Returns matching logs with pagination.

**Auth:** Bearer token (any authenticated user)

**Query Parameters:**
| Param         | Type   | Description                            |
|---------------|--------|----------------------------------------|
| projectId     | uuid   | Filter by project                      |
| environmentId | string | Filter by environment                  |
| serviceName   | string | Filter by service name                 |
| level         | string | Filter by log level (e.g., `ERROR`)    |
| search        | string | Text search in log message             |
| limit         | number | Max results (default: 50)              |
| offset        | number | Pagination offset (default: 0)         |

**Response `200`:**
```json
{
  "logs": [
    {
      "_id": "mongo-id",
      "projectId": "uuid",
      "environment": "production",
      "serviceName": "api",
      "level": "ERROR",
      "message": "Connection timeout",
      "timestamp": "2026-07-01T12:00:00.000Z"
    }
  ],
  "total": 42
}
```

---

## Error Codes

| Status | Error | Description |
|--------|-------|-------------|
| 400    | `...` | Query error |

---

## Related

- [Metrics API](metrics.md)
- [Monitoring Guide](/docs/guides/monitoring)
- [SDK Logging Guide](/docs/guides/sdk-metrics-and-logging)
