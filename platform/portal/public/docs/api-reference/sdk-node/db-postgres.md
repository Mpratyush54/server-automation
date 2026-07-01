# PostgreSQL — PostgresManager

Manages a **pg** connection pool for PostgreSQL. Automatically connected when `'postgres'` is included in the `databases` array during `PlatformClient.init()`.

---

## Import

```typescript
import { PostgresManager } from '@mpratyush54/sdk-node';

// Access via client:
// client.db.postgres
```

---

## Constructor

```typescript
const pg = new PostgresManager(config?: PostgresConfig);
```

### `PostgresConfig`

| Field | Environment variable | Default |
|---|---|---|
| `host` | `PLATFORM_PG_HOST` | `localhost` |
| `port` | `PLATFORM_PG_PORT` | `5432` |
| `user` | `PLATFORM_PG_USER` | `platform` |
| `password` | `PLATFORM_PG_PASSWORD` | `platform` |
| `database` | `PLATFORM_PG_DB` | `platform` |
| `poolSize` | — | `10` |

---

## Methods

### `connect()`

```typescript
await pg.connect(): Promise<void>
```

Creates the `pg.Pool` and runs `SELECT 1` to verify the connection. On failure, schedules automatic reconnection with exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s — up to 5 retries).

### `query(text, params?)`

```typescript
await pg.query(text: string, params?: any[]): Promise<QueryResult>
```

Executes a parameterised SQL query. Throws if not connected.

### `getClient()`

```typescript
await pg.getClient(): Promise<PoolClient>
```

Obtains a dedicated connection from the pool for transactions.

### `disconnect()`

```typescript
await pg.disconnect(): Promise<void>
```

Closes all pool connections.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `pg.isConnected` | `boolean` | Whether the pool is currently connected |
| `pg.health` | `{ connected, poolSize }` | Health-check summary |

---

## Auto-connect via `PlatformClient`

When `databases: ['postgres']` is passed to `init()`, credentials are fetched automatically from the Platform API (`GET /api/sdk/db-credentials`), and the manager is available at `client.db.postgres` immediately after `init()` resolves.

---

## Full Example

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';

const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-service',
    platformUrl: 'https://platform.example.com',
    databases: ['postgres'],
  });

  const pg = client.db.postgres!;

  // Create table
  await pg.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE
    )
  `);

  // Insert
  await pg.query('INSERT INTO users (name, email) VALUES ($1, $2)', ['Alice', 'alice@example.com']);

  // Query
  const { rows } = await pg.query('SELECT * FROM users');
  console.log(rows);

  // Transaction
  const conn = await pg.getClient();
  try {
    await conn.query('BEGIN');
    await conn.query('UPDATE users SET name = $1 WHERE id = $2', ['Alicia', 1]);
    await conn.query('COMMIT');
  } catch (e) {
    await conn.query('ROLLBACK');
    throw e;
  } finally {
    conn.release();
  }

  await client.shutdown();
}

main();
```

---

## Error Handling

- Connection failure is **non-blocking** — `isConnected` remains `false` and the SDK continues.
- Exponential backoff reconnection is attempted automatically (5 retries max).
- `query()` and `getClient()` throw if the pool was never created.
