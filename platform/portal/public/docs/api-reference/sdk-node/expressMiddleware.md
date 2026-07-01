# expressMiddleware

Auto-tracks HTTP request metrics per route: latency, status code, and heap memory delta. Compatible with **Express**, **Fastify**, and **NestJS** (any framework that uses the `(req, res, next)` signature).

---

## Import

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

const client = new PlatformClient();
// ... after client.init()
app.use(client.expressMiddleware());
```

The middleware is also exported directly from the metrics module:

```typescript
import { metricsClient } from '@mpratyush54/sdk-node';
app.use(metricsClient.middleware());
```

---

## How It Works

1. Captures `process.hrtime.bigint()` and `process.memoryUsage().heapUsed` at request start.
2. Listens on `res.on('finish')`.
3. On finish, calculates duration (ms) and heap delta (bytes).
4. Normalises the URL path — UUIDs and numeric segments are replaced with `:id` (e.g. `/users/abc-123` → `/users/:id`).
5. Appends the metric entry to an in-memory buffer.
6. The buffer is flushed to `POST /api/sdk/api-metrics` every **5 seconds** or when it reaches **100 entries**.

---

## Metric Entry Shape

```typescript
interface ApiMetricEntry {
  route: string;        // Normalised path, e.g. /users/:id
  method: string;       // GET, POST, PUT, DELETE, etc.
  statusCode: number;   // 200, 404, 500, etc.
  durationMs: number;   // Response time in milliseconds
  memoryDeltaBytes: number; // Heap used delta
  environment: string;  // e.g. "production"
  timestamp: string;    // ISO-8601
}
```

---

## Full Example

```typescript
import express from 'express';
import { PlatformClient } from '@mpratyush54/sdk-node';

const app = express();
const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-express-app',
    platformUrl: 'https://platform.example.com',
    environmentName: 'production',
  });

  // Track metrics on every route
  app.use(client.expressMiddleware());

  app.get('/users/:id', (req, res) => {
    res.json({ userId: req.params.id });
  });

  app.post('/api/data', express.json(), (req, res) => {
    res.status(201).json({ received: true });
  });

  app.listen(8080);
}

main();
```

---

## Error Handling

- Metrics flush failures are **silent** — the middleware never throws.
- On flush failure, up to 50 entries are re-queued (max 500 buffer cap) to avoid memory bloat.
- URL normalisation strips query strings and trailing slashes, so `/api/items?page=1` and `/api/items/` both become `/api/items`.
