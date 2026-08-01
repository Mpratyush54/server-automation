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
from platform_sdk import PlatformClient  # or: from platform_sdk import platform

client = PlatformClient()
client.init(
    project_name="my-python-service",
    platform_url="https://api.example.sslip.io",
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

platform.init(project_name="my-service", platform_url="https://api.example.sslip.io")
platform.log("INFO", "hello")
```

## What `init()` does

1. Registers with `POST /api/sdk/register`
2. Starts a daemon **heartbeat** thread (every 15s)
3. Connects any of `postgres` / `mongo` / `redis` listed in `databases` (non-blocking on failure)

## API surface

| Method / prop | Purpose |
|---------------|---------|
| `init(...)` | Configure + register + optional DBs |
| `config(key)` | Fetch remote config value |
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

Docs: [Python quickstart](../docs/getting-started/python-sdk-quickstart.md) · [API](../docs/api-reference/sdk-python/PlatformClient.md)

## License

MIT
