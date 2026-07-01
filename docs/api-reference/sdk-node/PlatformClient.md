# PlatformClient (Node.js SDK)

The main entry point for the `@mpratyush54/sdk-node` package. Handles service registration, heartbeat, logging, metrics, config, storage, and optional database connections.

---

## Installation

```bash
npm install @mpratyush54/sdk-node
```

Requires **Node.js >= 18**.

---

## Import

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

// Or use the default singleton export
import platform from '@mpratyush54/sdk-node';
```

---

## Constructor

```typescript
const client = new PlatformClient();
```

The constructor takes no arguments. All configuration is passed to `init()`.

---

## `init(options)` — Initialise the client

```typescript
await client.init(options: PlatformOptions): Promise<void>
```

### `PlatformOptions`

| Property | Type | Default | Description |
|---|---|---|---|
| `projectName` | `string` | — | **Required.** Your Platform project name |
| `platformUrl` | `string` | — | **Required.** Platform API base URL (e.g. `https://platform.example.com`) |
| `sdkToken` | `string?` | `process.env.PLATFORM_SDK_TOKEN` | Bearer token for API authentication |
| `environmentName` | `string` | `'development'` | Deployment environment label |
| `version` | `string` | `'1.0.0'` | Application version |
| `branch` | `string` | `'main'` | Git branch name |
| `commitSha` | `string?` | — | Git commit SHA |
| `namespace` | `string?` | — | Kubernetes namespace or equivalent |
| `hostname` | `string` | `os.hostname()` | Machine hostname |
| `infisicalEnv` | `string?` | — | Infisical environment slug for secret injection |
| `databases` | `string[]` | `[]` | Database types to auto-connect: `'postgres'`, `'mongo'`, `'redis'` |

### What `init()` does

1. Configures the internal HTTP client with the platform URL and auth header.
2. Configures the logger, metrics tracker, config client, and storage client with project context.
3. **Registers** the service with the Platform API (`POST /api/sdk/register`).
4. Loads remote config values and starts a background refresh (every 30 s).
5. Starts a **heartbeat** (every 15 s) sending CPU %, memory, uptime, and DB health.
6. Starts **CPU sampling** (every 10 s) for real-time CPU utilisation.
7. Connects to each database type listed in `databases` using credentials fetched via registration.

---

## `config(key, defaultValue?)` — Read remote config

```typescript
client.config(key: string, defaultValue?: any): any
```

Synchronously reads a config value from the in-memory cache (populated by `init()` and refreshed every 30 s). Returns the cached value, or `defaultValue` if the key is absent.

Config values of `'true'` / `'false'` are automatically coerced to booleans.

---

## `expressMiddleware()` — HTTP metrics middleware

```typescript
client.expressMiddleware(): (req, res, next) => void
```

Returns a middleware function compatible with Express, Fastify, and NestJS. Tracks per-route latency, response status code, and heap memory delta. Metrics are batched and flushed every 5 s to `POST /api/sdk/api-metrics`.

See [expressMiddleware](expressMiddleware.md).

---

## `captureConsole()` — Capture console.\* calls

```typescript
client.captureConsole(): this
```

Patches `console.log`, `console.warn`, `console.error`, and `console.debug` to forward all output to the Platform logger. Returns `this` for chaining.

See [captureConsole](captureConsole.md).

---

## `winstonTransport()` — Winston-compatible transport

```typescript
client.winstonTransport(): object
```

Returns an object with a `log()` method that satisfies the Winston transport interface. Every log entry is forwarded to the Platform logger.

---

## `pinoTransport()` — Pino-compatible transport

```typescript
client.pinoTransport(): { write: (chunk: string) => void }
```

Returns a stream-like object with a `write()` method that accepts newline-delimited JSON Pino output and forwards it to the Platform logger.

---

## `shutdown()` — Graceful shutdown

```typescript
await client.shutdown(): Promise<void>
```

- Stops heartbeat, CPU sampling, metrics flush, config refresh, and logger flush.
- Disconnects all database managers (PostgreSQL, MongoDB, Redis).
- Deregisters the service from the Platform API (`POST /api/sdk/deregister`).

---

## Instance Properties

| Property | Type | Description |
|---|---|---|
| `client.registration` | `RegistrationClient` | Low-level registration client |
| `client.logger` | `LoggerClient` | Logger instance with `info`, `warn`, `error`, `debug` |
| `client.metrics` | `MetricsClient` | Metrics buffer and flush engine |
| `client.configClient` | `ConfigClient` | Remote config cache client |
| `client.storage` | `StorageClient` | File upload / signed URL / delete client |
| `client.db.postgres` | `PostgresManager?` | PostgreSQL pool manager (if enabled) |
| `client.db.mongo` | `MongoManager?` | MongoDB connection manager (if enabled) |
| `client.db.redis` | `RedisManager?` | Redis connection manager (if enabled) |

---

## Full Example — Express App

```typescript
import express from 'express';
import { PlatformClient } from '@mpratyush54/sdk-node';

const app = express();
const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-api-service',
    platformUrl: 'https://platform.example.com',
    sdkToken: process.env.PLATFORM_SDK_TOKEN,
    environmentName: process.env.NODE_ENV || 'development',
    version: '2.1.0',
    branch: 'main',
    databases: ['postgres', 'redis'],
  });

  // Middleware — tracks every request
  app.use(client.expressMiddleware());

  // Capture console.log/warn/error
  client.captureConsole();

  // Routes
  app.get('/api/health', (req, res) => {
    const pgHealthy = client.db.postgres?.isConnected;
    const redisHealthy = client.db.redis?.isConnected;
    res.json({ status: 'ok', postgres: pgHealthy, redis: redisHealthy });
  });

  app.get('/api/items', async (req, res) => {
    const result = await client.db.postgres!.query('SELECT * FROM items');
    res.json(result.rows);
  });

  app.listen(3000, () => {
    client.logger.info('Server started', { port: 3000 });
  });
}

main().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', async () => {
  await client.shutdown();
  process.exit(0);
});
```

---

## Error Handling

- **Registration failure:** Non-blocking; logs a warning and continues.
- **Config fetch failure:** Non-blocking; uses cached values or defaults.
- **Database connection failure:** Non-blocking; the manager is still created but `isConnected` will be `false`. Automatic reconnection is attempted with exponential backoff (up to 5 retries, max 30 s delay).
- **Metrics / Log flush failure:** Entries are re-queued (up to 500) to avoid data loss.
- `shutdown()` uses `Promise.allSettled` so a single disconnect failure never prevents other resources from being released.
