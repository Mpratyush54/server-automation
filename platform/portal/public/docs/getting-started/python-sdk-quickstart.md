# Python SDK Quickstart

Instrument a Python service with registration, heartbeats, structured logs, config, and optional databases.

Package: [`mpratyush54-sdk`](https://pypi.org/project/mpratyush54-sdk/) · Examples: [`sdk-python/examples`](../../sdk-python/examples)

## Installation

```bash
pip install mpratyush54-sdk
```

## Basic usage

```python
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name="my-python-service",
    platform_url=os.environ["PLATFORM_URL"],
    environment_name="development",
)

client.log("INFO", "ready")
print(client.config("FEATURE_X"))
client.shutdown()
```

Or use the module singleton:

```python
from platform_sdk import platform

platform.init(project_name="my-service", platform_url="https://api.example.sslip.io")
platform.log("INFO", "hello")
```

## Databases

```python
client.init(
    project_name="my-service",
    platform_url=os.environ["PLATFORM_URL"],
    databases=["postgres", "mongo", "redis"],
)

rows = client.db["postgres"].execute("SELECT 1")
```

Managers live under `client.db["postgres" | "mongo" | "redis"]`. Connection failures are logged and non-blocking.

## Logging & storage

```python
client.log("WARN", "high latency", {"route": "/api/users", "ms": 900})
client.storage_upload("/tmp/report.bin", "uploads")
```

## Flask / FastAPI

The SDK does **not** ship framework middleware yet. Time requests yourself and call `client.log(...)` — see:

- [`sdk-python/examples/03_flask_manual_metrics.py`](../../sdk-python/examples/03_flask_manual_metrics.py)
- [`sdk-python/examples/04_fastapi_manual_metrics.py`](../../sdk-python/examples/04_fastapi_manual_metrics.py)

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `project_name` | — | Required |
| `platform_url` | — | Required API base |
| `environment_name` | `development` | Env label |
| `version` / `branch` / `commit_sha` | — | Build metadata |
| `databases` | `[]` | `postgres` · `mongo` · `redis` |

## More examples

| Path | Topic |
|------|--------|
| [`01_basic.py`](../../sdk-python/examples/01_basic.py) | Init + log + config |
| [`02_with_databases.py`](../../sdk-python/examples/02_with_databases.py) | DB managers |
| [`03_flask_manual_metrics.py`](../../sdk-python/examples/03_flask_manual_metrics.py) | Flask timing |
| [`04_fastapi_manual_metrics.py`](../../sdk-python/examples/04_fastapi_manual_metrics.py) | FastAPI timing |

## API reference

[PlatformClient](../api-reference/sdk-python/PlatformClient.md) · [Postgres](../api-reference/sdk-python/db-postgres.md) · [Mongo](../api-reference/sdk-python/db-mongo.md) · [Redis](../api-reference/sdk-python/db-redis.md)
