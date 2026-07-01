# PlatformClient (Python SDK)

The main entry point for the `platform-sdk-python` package. Handles service registration, heartbeat, logging, config, storage, and optional database connections.

---

## Installation

```bash
pip install platform-sdk-python
```

Requires **Python >= 3.10**.

Dependencies: `psycopg2-binary`, `pymongo`, `redis` (optional — only needed if using the respective database).

---

## Import

```python
from platform_sdk import PlatformClient

# Or use the default singleton
from platform_sdk import platform
```

---

## Constructor

```python
client = PlatformClient()
```

The constructor takes no arguments. All configuration is passed to `init()`.

---

## `init(...)` — Initialise the client

```python
client.init(
    project_name: str,
    platform_url: str,
    environment_name: str = "development",
    version: str = "1.0.0",
    branch: str = "main",
    commit_sha: Optional[str] = None,
    namespace: Optional[str] = None,
    hostname: Optional[str] = None,
    databases: Optional[list[str]] = None,
) -> None
```

### Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `project_name` | `str` | — | **Required.** Your Platform project name |
| `platform_url` | `str` | — | **Required.** Platform API base URL (e.g. `https://platform.example.com`) |
| `environment_name` | `str` | `'development'` | Deployment environment label |
| `version` | `str` | `'1.0.0'` | Application version |
| `branch` | `str` | `'main'` | Git branch name |
| `commit_sha` | `str \| None` | — | Git commit SHA |
| `namespace` | `str \| None` | — | Kubernetes namespace or equivalent |
| `hostname` | `str \| None` | `os.uname().nodename` | Machine hostname |
| `databases` | `list[str] \| None` | `[]` | Database types to auto-connect: `'postgres'`, `'mongo'`, `'redis'` |

### What `init()` does

1. Registers the service with the Platform API (`POST /api/sdk/register`).
2. Starts a background **heartbeat** thread (every 15 s) sending `POST /api/sdk/heartbeat`.
3. Connects to each database type listed in `databases` (non-blocking — failures are logged as warnings).

---

## `config(key)` — Read remote config

```python
client.config(key: str) -> Optional[Any]
```

Fetches all config from `GET /api/config` and returns the value for `key`. Returns `None` if the key is absent.

---

## `log(level, message, metadata?)` — Send a log entry

```python
client.log(
    level: str,
    message: str,
    metadata: Optional[dict] = None,
) -> None
```

Sends a log entry to `POST /api/logs/ingest`. Example levels: `'INFO'`, `'WARN'`, `'ERROR'`, `'DEBUG'`.

---

## `storage_upload(file_path, bucket)` — Upload a file

```python
client.storage_upload(
    file_path: str,
    bucket: str,
) -> Optional[dict]
```

Uploads a file from disk to `POST /api/storage/upload-url`. Returns the API response dict or `None` on failure.

---

## `shutdown()` — Graceful shutdown

```python
client.shutdown() -> None
```

Disconnects all database connections (PostgreSQL, MongoDB, Redis). Errors are silently ignored.

---

## Instance Properties

| Property | Type | Description |
|---|---|---|
| `client.db` | `dict` | Dictionary of database managers keyed by type (`'postgres'`, `'mongo'`, `'redis'`) |
| `client.initialized` | `bool` | Whether `init()` completed successfully |

---

## Singleton

The module also exports a pre-created singleton:

```python
from platform_sdk import platform
platform.init(
    project_name='my-service',
    platform_url='https://platform.example.com',
)
```

---

## Full Example

```python
from platform_sdk import PlatformClient

client = PlatformClient()

def main():
    client.init(
        project_name="my-python-service",
        platform_url="https://platform.example.com",
        environment_name="production",
        version="2.0.0",
        databases=["postgres", "redis"],
    )

    # Read remote config
    feature_flag = client.config("MY_FEATURE_ENABLED")
    print(f"Feature flag: {feature_flag}")

    # Log
    client.log("INFO", "Service started", {"port": 8080})

    # Database access
    if "postgres" in client.db:
        pg = client.db["postgres"]
        rows = pg.execute("SELECT * FROM users")
        print(f"Users: {rows}")

    if "redis" in client.db:
        r = client.db["redis"]
        r.set("my_key", "hello", ttl=3600)
        val = r.get("my_key")
        print(f"Redis value: {val}")

    client.shutdown()

if __name__ == "__main__":
    main()
```

---

## Error Handling

- Registration failure is **non-blocking** — logged as a warning.
- Database connection failures are **non-blocking** — the connection is skipped and a warning is logged.
- All HTTP requests (`_request`) catch `URLError` and general exceptions, log a warning, and return `None`.
- `shutdown()` silently ignores any errors during disconnect.
