# Redis — RedisManager (Python SDK)

Manages a **redis** (Redis client) connection to Redis. Automatically connected when `'redis'` is included in the `databases` list during `PlatformClient.init()`.

---

## Import

```python
from platform_sdk.db.redis import RedisManager

# Access via client:
# client.db['redis']
```

---

## Constructor

```python
redis_mgr = RedisManager(config: dict = None)
```

### Config dictionary

| Key | Environment variable | Default |
|---|---|---|
| `host` | `PLATFORM_REDIS_HOST` | `localhost` |
| `port` | `PLATFORM_REDIS_PORT` | `6379` |
| `password` | `PLATFORM_REDIS_PASSWORD` | (none) |
| `username` | `PLATFORM_REDIS_USERNAME` | (none — Redis `default` user) |
| `key_prefix` | `PLATFORM_REDIS_KEY_PREFIX` | `""` (no prefix) |
| `db` | `PLATFORM_REDIS_DB` | redis-py default (`0`) |
| `url` | `PLATFORM_REDIS_URL` | (none) — `redis://` or `rediss://` (TLS); URL values win |
| `ssl` | `PLATFORM_REDIS_TLS=true` | `False` |

Passing a `config` dict replaces the host/port/password environment defaults; `username` and
`key_prefix` still fall back to their environment variables when absent from the dict. An
explicit `key_prefix: ""` disables prefixing. Any other key is passed through to `redis.Redis`.

### Project ACL credentials

When created by `PlatformClient.init(databases=["redis"])`, the config comes from
`GET /api/sdk/db-credentials?projectId=…&dbTypes=redis&environment=…`, which returns a
per-project/environment ACL user (`username`, `password`) confined to `keyPrefix`
(`plat:<project>:<env>:`). The SDK maps `keyPrefix` to `key_prefix`. If the request fails the
manager uses the environment variables above; if the Platform reports a Redis provisioning
error the manager is registered but not connected.

---

## Methods

### `connect()`

```python
redis_mgr.connect() -> None
```

Creates a `redis.Redis` client with `decode_responses=True` and runs `ping()` to verify connectivity. Sets `self.connected = True`.

### `get(key)`

```python
redis_mgr.get(key: str) -> Optional[str]
```

Returns the string value for `key`, or `None` if the key does not exist or if not connected.

### `set(key, value, ttl?)`

```python
redis_mgr.set(key: str, value: str, ttl: int = None) -> None
```

Sets `key` to `value`. If `ttl` is provided, uses `SETEX` with the TTL in seconds.

### `delete(key)`

```python
redis_mgr.delete(key: str) -> Optional[int]
```

Deletes `key`; returns the number of keys removed, or `None` if not connected.

### `prefixed(key)`

```python
redis_mgr.prefixed(key: str | bytes) -> str | bytes
```

Returns `key` inside the project prefix. The prefix is applied once: a key that already starts
with the prefix is returned unchanged. `get`, `set` and `delete` call this automatically.
**Raw `redis_mgr.client` calls do not** — wrap every key argument yourself, e.g.
`redis_mgr.client.incr(redis_mgr.prefixed("counter"))`. Keys outside the prefix are refused by
the server ACL (`NoPermissionError`).

### `disconnect()`

```python
redis_mgr.disconnect() -> None
```

Closes the Redis connection. Sets `self.connected = False`.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `redis_mgr.connected` | `bool` | Whether the client is connected |
| `redis_mgr.key_prefix` | `str` | Prefix applied by the helpers (`""` when unset) |
| `redis_mgr.client` | `redis.Redis \| None` | Raw client; keys are **not** prefixed automatically |

---

## Auto-connect via `PlatformClient`

When `databases=['redis']` is passed to `init()`, the manager is created and available at `client.db['redis']` immediately after `init()` returns.

---

## Full Example

```python
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name="my-service",
    platform_url="https://platform.example.com",
    databases=["redis"],
)

r = client.db["redis"]

# Set with 1-hour TTL
r.set("session:abc123", '{"userId": 42}', ttl=3600)

# Get
raw = r.get("session:abc123")
print(f"Session: {raw}")

# Delete (prefixed automatically)
r.delete("session:abc123")

# Raw client: apply the prefix yourself
r.client.incr(r.prefixed("visits"))

client.shutdown()
```

> **Note:** The Python `RedisManager` exposes the raw `redis.Redis` client as `r.client` for advanced operations. The helper methods `get`, `set` and `delete` are convenience wrappers that apply the key prefix.

---

## Error Handling

- Connection failure raises an exception — `PlatformClient.init()` catches it and logs a warning.
- `get()` returns `None` if not connected (instead of throwing).
- `set()` / `delete()` silently no-op if not connected.
