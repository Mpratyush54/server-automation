# Python SDK Quickstart

Instrument your Python application with metrics, structured logging, and bug reporting.

## Installation

```bash
pip install platform-sdk-python
```

## Basic Usage

```python
from platform_sdk import PlatformClient

client = PlatformClient(
    api_url='http://localhost:3000',
    sdk_token='sdk_xxxxx',
    project_id='proj-xxxxx'
)
client.init()

# Track an API call metric
client.metrics.track_api_call('/api/users', 200, 45, 1024)
#  ──────────────┬─────────  ─┬─  ─┬─  ─┬─
#     route        status  ms    bytes

# Forward structured logs
client.logger.info('App started successfully')
client.logger.warn('Memory usage high', extra={'memory_mb': 256})
client.logger.error('Failed to connect', exc_info=True)
```

## Flask Middleware

Automatically instrument all incoming Flask requests:

```python
from flask import Flask
from platform_sdk import PlatformClient
from platform_sdk.flask import flask_middleware

app = Flask(__name__)
client = PlatformClient(
    api_url='http://localhost:3000',
    sdk_token='sdk_xxxxx',
    project_id='proj-xxxxx'
)
client.init()

flask_middleware(app, client)
# Tracks route, status code, duration, and response size for every request

@app.route('/api/users')
def get_users():
    return {'users': []}
```

## Django Middleware

Add to your Django `MIDDLEWARE` setting:

```python
# settings.py
MIDDLEWARE = [
    'platform_sdk.django.middleware.PlatformMiddleware',
    # ... other middleware
]

PLATFORM = {
    'api_url': 'http://localhost:3000',
    'sdk_token': 'sdk_xxxxx',
    'project_id': 'proj-xxxxx',
}
```

## Database Helpers

```python
from platform_sdk.db import MongoClient, PostgresPool, RedisClient

# MongoDB
mongo = MongoClient('mongodb://localhost:27017/mydb')
await mongo.connect()

# PostgreSQL
pg = PostgresPool('postgresql://user:pass@localhost/mydb')
await pg.connect()

# Redis
redis = RedisClient('redis://localhost:6379/0')
await redis.connect()
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `api_url` | `str` | — | Platform API base URL |
| `sdk_token` | `str` | — | SDK token from Project Settings |
| `project_id` | `str` | — | Project ID (`proj-xxxxx`) |
| `environment` | `str` | `os.environ.get('NODE_ENV')` | Deployment environment name |
| `flush_interval_ms` | `int` | `5000` | How often to batch-send metrics/logs |
| `max_queue_size` | `int` | `1000` | Max queued events before flush |

## API Reference

See the full [Python SDK API Reference](../api-reference/sdk-python/PlatformClient.md).
