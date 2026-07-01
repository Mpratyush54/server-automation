# Node.js SDK Quickstart

Instrument your Node.js application with metrics, structured logging, and bug reporting.

## Installation

```bash
npm install @mpratyush54/sdk-node
```

## Basic Usage

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

const client = new PlatformClient({
  apiUrl: 'http://localhost:3000',
  sdkToken: 'sdk_xxxxx',
  projectId: 'proj-xxxxx'
});

await client.init();

// Track an API call metric
client.metrics.trackApiCall('/api/users', 200, 45, 1024);
//  ──────────────┬─────────  ─┬─  ─┬─  ─┬─
//     route        status  ms    bytes

// Forward structured logs
client.logger.info('App started successfully');
client.logger.warn('Memory usage high', { memoryUsage: process.memoryUsage() });
client.logger.error('Failed to connect', new Error('ECONNREFUSED'));
```

## Express Middleware

Automatically instrument all incoming HTTP requests:

```typescript
import express from 'express';
import { PlatformClient, expressMiddleware } from '@mpratyush54/sdk-node';

const app = express();
const client = new PlatformClient({
  apiUrl: 'http://localhost:3000',
  sdkToken: 'sdk_xxxxx',
  projectId: 'proj-xxxxx'
});

await client.init();

app.use(expressMiddleware(client));
// Tracks route, status code, duration, and response size for every request

app.get('/api/users', (req, res) => {
  res.json({ users: [] });
});

app.listen(3001);
```

## Console Capture

Forward all `console.log`, `console.warn`, and `console.error` calls to the platform logger:

```typescript
import { captureConsole } from '@mpratyush54/sdk-node';

captureConsole(client);
// Now every console.log/warn/error is also sent as a structured log
```

## Database Helpers

The SDK includes optional wrappers for managed databases:

```typescript
import { MongoClient, PostgresPool, RedisClient } from '@mpratyush54/sdk-node';

// MongoDB — auto-instruments queries
const mongo = new MongoClient(process.env.MONGO_URI);
await mongo.connect();

// PostgreSQL — auto-instruments queries
const pg = new PostgresPool({ connectionString: process.env.POSTGRES_URI });
await pg.connect();

// Redis — auto-instruments commands
const redis = new RedisClient({ url: process.env.REDIS_URI });
await redis.connect();
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | — | Platform API base URL |
| `sdkToken` | `string` | — | SDK token from Project Settings |
| `projectId` | `string` | — | Project ID (`proj-xxxxx`) |
| `environment` | `string` | `process.env.NODE_ENV` | Deployment environment name |
| `flushIntervalMs` | `number` | `5000` | How often to batch-send metrics/logs |
| `maxQueueSize` | `number` | `1000` | Max queued events before flush |

## API Reference

See the full [Node.js SDK API Reference](../api-reference/sdk-node/PlatformClient.md).
