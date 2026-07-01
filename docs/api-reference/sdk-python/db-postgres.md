# PostgreSQL — PostgresManager (Python SDK)

Manages a **psycopg2** threaded connection pool for PostgreSQL. Automatically connected when `'postgres'` is included in the `databases` list during `PlatformClient.init()`.

---

## Import

```python
from platform_sdk.db.postgres import PostgresManager

# Access via client:
# client.db['postgres']
```

---

## Constructor

```python
pg = PostgresManager(config: dict = None)
```

### Config dictionary

| Key | Environment variable | Default |
|---|---|---|
| `host` | `PLATFORM_PG_HOST` | `localhost` |
| `port` | `PLATFORM_PG_PORT` | `5432` |
| `user` | `PLATFORM_PG_USER` | `platform` |
| `password` | `PLATFORM_PG_PASSWORD` | `platform` |
| `database` | `PLATFORM_PG_DB` | `platform` |
| `pool_size` | — | `10` |

---

## Methods

### `connect()`

```python
pg.connect() -> None
```

Creates a `psycopg2.pool.ThreadedConnectionPool` (min 1, max `pool_size` connections) and verifies connectivity by checking out and returning a connection. Sets `self.connected = True`.

### `execute(query, params?)`

```python
pg.execute(query: str, params: tuple = None) -> list
```

Runs a parameterised query. For `SELECT` / queries that return rows, returns a **list of tuples**. For `INSERT` / `UPDATE` / `DELETE`, commits and returns an empty list.

### `disconnect()`

```python
pg.disconnect() -> None
```

Closes all connections in the pool via `pool.closeall()`. Sets `self.connected = False`.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `pg.connected` | `bool` | Whether the pool is connected |

---

## Auto-connect via `PlatformClient`

When `databases=['postgres']` is passed to `init()`, the manager is created and available at `client.db['postgres']` immediately after `init()` returns.

---

## Full Example

```python
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name="my-service",
    platform_url="https://platform.example.com",
    databases=["postgres"],
)

pg = client.db["postgres"]

# Create table
pg.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE
    )
""")

# Insert
pg.execute(
    "INSERT INTO users (name, email) VALUES (%s, %s)",
    ("Alice", "alice@example.com"),
)

# Query
rows = pg.execute("SELECT * FROM users")
for row in rows:
    print(row)

client.shutdown()
```

---

## Error Handling

- Connection failure raises an exception — `PlatformClient.init()` catches it and logs a warning.
- `execute()` raises `RuntimeError('PostgreSQL not connected')` if called before `connect()`.
- Connections are always returned to the pool via a `try/finally` block.
