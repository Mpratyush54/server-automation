# Redis — RedisManager

Manages an **ioredis** connection to Redis. Automatically connected when `'redis'` is included in the `databases` array during `PlatformClient.init()`.

---

## Import

```typescript
import { RedisManager } from '@mpratyush54/sdk-node';

// Access via client:
// client.db.redis
```

---

## Constructor

```typescript
const redis = new RedisManager(config?: RedisConfig);
```

### `RedisConfig`

| Field | Environment variable | Default |
|---|---|---|
| `host` | `PLATFORM_REDIS_HOST` | `localhost` |
| `port` | `PLATFORM_REDIS_PORT` | `6379` |
| `password` | `PLATFORM_REDIS_PASSWORD` | (none) |

---

## Methods

### `connect()`

```typescript
await redis.connect(): Promise<void>
```

Creates an ioredis client with `lazyConnect: true` and calls `connect()`. On failure, schedules automatic reconnection with exponential backoff (up to 5 retries, max 30 s delay).

### `get(key)`

```typescript
await redis.get(key: string): Promise<string | null>
```

Returns the string value for `key`, or `null` if the key does not exist.

### `set(key, value, ttl?)`

```typescript
await redis.set(key: string, value: string, ttl?: number): Promise<void>
```

Sets `key` to `value`. If `ttl` is provided, uses `SETEX` with the TTL in seconds; otherwise uses plain `SET`.

### `del(key)`

```typescript
await redis.del(key: string): Promise<void>
```

Deletes `key`.

### `disconnect()`

```typescript
await redis.disconnect(): Promise<void>
```

Closes the Redis connection via `client.quit()`.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `redis.isConnected` | `boolean` | Whether the client is connected |
| `redis.health` | `{ connected }` | Health-check summary |

---

## Auto-connect via `PlatformClient`

When `databases: ['redis']` is passed to `init()`, credentials are fetched automatically from the Platform API (`GET /api/sdk/db-credentials`), and the manager is available at `client.db.redis` immediately after `init()` resolves.

---

## Full Example

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-service',
    platformUrl: 'https://platform.example.com',
    databases: ['redis'],
  });

  const redis = client.db.redis!;

  // Set with 1-hour TTL
  await redis.set('session:abc123', JSON.stringify({ userId: 42 }), 3600);

  // Get
  const raw = await redis.get('session:abc123');
  const session = raw ? JSON.parse(raw) : null;
  console.log('Session:', session);

  // Delete
  await redis.del('session:abc123');

  await client.shutdown();
}

main();
```

---

## Error Handling

- Connection failure is **non-blocking** — `isConnected` remains `false`.
- Exponential backoff reconnection is attempted automatically (5 retries max).
- `get()` returns `null` if not connected (instead of throwing).
- `set()` and `del()` silently no-op if not connected.
