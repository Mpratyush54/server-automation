# mpratyush54-sdk

Official Python SDK for Platform — registration, heartbeats, logging, config, storage helpers, and managed DB connections.

**Requires Python ≥ 3.10.** Package: [`mpratyush54-sdk`](https://pypi.org/project/mpratyush54-sdk/)

## Install

```bash
pip install mpratyush54-sdk
```

Optional DB drivers are declared as package dependencies (`psycopg2-binary`, `pymongo`, `redis`).

## Quick start

```python
import os
from platform_sdk import PlatformClient  # or: from platform_sdk import platform

client = PlatformClient()
client.init(
    project_name="my-python-service",
    platform_url="https://api.example.sslip.io",
    sdk_token=os.environ["PLATFORM_SDK_TOKEN"],  # sdk_live_... / sdk_test_... (Project -> Tokens)
    environment_name="development",
    databases=["postgres", "mongo", "redis"],  # optional
)

client.log("INFO", "service ready", {"pid": 1})
flag = client.config("FEATURE_X")

# After init with databases=...
rows = client.db["postgres"].execute("SELECT 1")
client.shutdown()
```

Singleton style:

```python
from platform_sdk import platform

# sdk_token defaults to the PLATFORM_SDK_TOKEN environment variable
platform.init(project_name="my-service", platform_url="https://api.example.sslip.io")
platform.log("INFO", "hello")
```

Every Platform API call sends `Authorization: Bearer <sdk_token>`. Without a token the API rejects
registration, heartbeats, logs and config (an error is logged). Postgres has no default password: set
`PLATFORM_PG_PASSWORD` (or pass a config with `password`) or `connect()` raises.

## What `init()` does

1. Registers with `POST /api/sdk/register`
2. Starts a daemon **heartbeat** thread (every 15s)
3. Connects any of `postgres` / `mongo` / `redis` listed in `databases` (non-blocking on failure)

## Project Redis credentials

When `databases` includes `redis`, initialization fetches `/api/sdk/db-credentials` with the
SDK token, project and environment. The returned ACL `username`, password and `keyPrefix`
are used automatically. If the request is unavailable, the manager falls back to environment
configuration. An explicit Redis provisioning error leaves the manager registered at
`client.db["redis"]` but disconnected (helpers return `None` / no-op).

```python
# After client.init(..., databases=["redis"])
r = client.db["redis"]
r.set("ping", "1", ttl=60)
assert r.get("ping") == "1"
assert r.get(r.prefixed("ping")) == "1"  # already-prefixed keys stay unchanged
r.delete("ping")
```

`get`, `set` (including TTL) and `delete` transparently prepend the project's key prefix
once. The Redis ACL enforces access to that prefix on the server. Raw `r.client` calls
do **not** prepend it: use `r.client.incr(r.prefixed("counter"))` and apply `prefixed()` to
every key argument for multi-key commands. Prefixing is a convenience; Redis ACLs provide
the access boundary.

For a standalone manager, pass `RedisManager({"host": "localhost", "port": 6379,
"username": "project-user", "password": "...", "key_prefix": "project:"})`
from `platform_sdk.db.redis`. Alternatively set `PLATFORM_REDIS_HOST`, `PLATFORM_REDIS_PORT`,
`PLATFORM_REDIS_PASSWORD`, `PLATFORM_REDIS_USERNAME` and `PLATFORM_REDIS_KEY_PREFIX`.
Explicit `username` and `key_prefix` config values override their environment values.
Without a username or prefix, existing default-user, unprefixed connections still work.
For TLS, pass `url="rediss://host:port/db"` (or set `PLATFORM_REDIS_URL`), or set `ssl=True`
(`PLATFORM_REDIS_TLS=true`). `PLATFORM_REDIS_DB` selects the database. Other redis-py keyword
arguments in the config dict are passed through.

Run [`examples/05_redis_acl.py`](./examples/05_redis_acl.py) with `PLATFORM_URL`,
`PLATFORM_SDK_TOKEN` and `PROJECT_NAME` set (optionally `ENVIRONMENT_NAME`) to exercise
the project credentials and verify that Redis refuses a read outside the prefix.
For provisioning acceptance, run it against a fresh Ubuntu 24.04
installation created with `sudo platformctl provision`, with Redis enabled for the project.
An operator can verify the ACL username via `CLIENT LIST` and the stored key prefix
using administrative Redis access. The SDK token and Redis password should not be printed.

## API surface

| Method / prop | Purpose |
|---------------|---------|
| `init(...)` | Configure + register + optional DBs |
| `config(key)` | Fetch remote config value (`GET /api/sdk/config`) |
| `log(level, message, metadata?)` | Ship a log line |
| `storage_upload(path, bucket)` | Request an upload URL |
| `db` | Dict of connected managers (`postgres` / `mongo` / `redis`) |
| `shutdown()` | Disconnect DBs |

There is **no** built-in Flask/Django middleware yet — record metrics yourself or put a reverse proxy in front. See examples for manual timing patterns.

## Examples

| File | Topic |
|------|--------|
| [`examples/01_basic.py`](./examples/01_basic.py) | Init + log + config |
| [`examples/02_with_databases.py`](./examples/02_with_databases.py) | Postgres / Mongo / Redis |
| [`examples/03_flask_manual_metrics.py`](./examples/03_flask_manual_metrics.py) | Flask + timed requests |
| [`examples/04_fastapi_manual_metrics.py`](./examples/04_fastapi_manual_metrics.py) | FastAPI + middleware timing |
| [`examples/05_redis_acl.py`](./examples/05_redis_acl.py) | Project Redis ACL user + key prefix |

Docs: [Python quickstart](../docs/getting-started/python-sdk-quickstart.md) · [API](../docs/api-reference/sdk-python/PlatformClient.md)

## License

MIT

## Optional OpenTelemetry and continuous profiling

Await Node `init()` / call Python `init()` before framework or driver imports. Telemetry
only starts when the platform SDK config explicitly enables it; `PLATFORM_OTEL_ENABLED=false`
opts out. Install the optional telemetry peers (Node) or `[telemetry,profiling]` extras (Python).
See [backend telemetry setup, flags and VM verification](../examples/sdk-apps/TELEMETRY.md).
