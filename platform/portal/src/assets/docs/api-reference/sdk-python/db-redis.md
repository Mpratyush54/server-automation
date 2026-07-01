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

# Delete
import redis as redis_module
r.client.delete("session:abc123")  # uses raw Redis client

client.shutdown()
```

> **Note:** The Python `RedisManager` exposes the raw `redis.Redis` client as `r.client` for advanced operations. The helper methods `get` and `set` are convenience wrappers.

---

## Error Handling

- Connection failure raises an exception — `PlatformClient.init()` catches it and logs a warning.
- `get()` returns `None` if not connected (instead of throwing).
- `set()` silently no-ops if not connected.
