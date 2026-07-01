# Metrics API

Raw and aggregated performance metrics collected from SDK agents and services.

All metric data is stored in MongoDB.

---

## `GET` /api/metrics

Returns raw metrics records, sorted by timestamp descending (up to 100). Can be filtered by `projectId`.

**Auth:** Bearer token (any authenticated user)

**Query Parameters:**
| Param     | Type   | Description       |
|-----------|--------|-------------------|
| projectId | uuid   | Filter by project |

**Response `200`:**
```json
[
  {
    "_id": "mongo-id",
    "projectId": "uuid",
    "environment": "development",
    "registrationId": "uuid",
    "cpuPct": 12.5,
    "memoryMb": 256,
    "heapMb": 160,
    "uptimeS": 3600,
    "requestCount": 42,
    "avgResponseMs": 15,
    "p95ResponseMs": 40,
    "errors4xx": 0,
    "errors5xx": 0,
    "dbHealth": {
      "postgres": { "activeCount": 2, "idleCount": 8, "status": "connected" }
    },
    "timestamp": "2026-07-01T12:00:00.000Z"
  }
]
```

---

## `GET` /api/metrics/aggregated

Returns aggregated averages for the most recent 20 metric records. Includes CPU average, memory average, and error rate.

**Auth:** Bearer token (any authenticated user)

**Query Parameters:**
| Param     | Type   | Description       |
|-----------|--------|-------------------|
| projectId | uuid   | Filter by project |

**Response `200`:**
```json
{
  "cpuAvg": 15.3,
  "memoryAvg": 280.5,
  "errorRate": 0.5
}
```

---

## `GET` /api/sdk/api-metrics

Returns aggregated API performance metrics with p50, p95, and p99 latency percentiles. Metrics are grouped by route and HTTP method.

**Auth:** Bearer token (any authenticated user)

**Query Parameters:**
| Param       | Type   | Description                    |
|-------------|--------|--------------------------------|
| projectId   | uuid   | **Required** — Filter by project|
| environment | string | Filter by environment name     |
| from        | string | ISO date — start of range      |
| to          | string | ISO date — end of range        |

**Response `200`:**
```json
{
  "metrics": [
    {
      "_id": {
        "route": "/api/users",
        "method": "GET"
      },
      "count": 150,
      "avgDuration": 42.5,
      "errors4xx": 2,
      "errors5xx": 0,
      "lastSeen": "2026-07-01T12:00:00.000Z",
      "p50": 35,
      "p95": 95,
      "p99": 200
    }
  ]
}
```

---

## `POST` /api/sdk/api-metrics

Ingests API metrics from SDK agents. Accepts an array of metric records. Used internally by the SDKs.

**Auth:** SDK token (Bearer token starting with `sdk-`)

**Request Body:**
```json
{
  "projectId": "uuid",
  "metrics": [
    {
      "route": "/api/users",
      "method": "GET",
      "statusCode": 200,
      "durationMs": 42,
      "memoryDeltaBytes": 1024,
      "environment": "production",
      "timestamp": "2026-07-01T12:00:00.000Z"
    }
  ]
}
```

**Response `200`:**
```json
{ "saved": 1 }
```

---

## Error Codes

| Status | Error                         | Description                |
|--------|-------------------------------|----------------------------|
| 400    | `projectId required`          | Missing required query param|

---

## Related

- [Audit Logs API](audit-logs.md)
- [Monitoring Guide](/docs/guides/monitoring)
- [SDK Metrics Guide](/docs/guides/sdk-metrics-and-logging)
