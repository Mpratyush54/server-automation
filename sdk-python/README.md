# mpratyush54-sdk

The official Python SDK for the Platform.

This SDK provides core backend integrations for your Python microservices, including auto-registration with the platform, metrics aggregation, structured logging, and standardized database connections.

## Installation

```bash
pip install mpratyush54-sdk
```

## Features

- **Service Registration:** Automatically registers your microservice with the Platform API on startup.
- **Metrics Aggregation:** Utility decorators and middleware to record route metrics, execution times, and memory deltas.
- **Database Connections:** Pre-configured Psycopg2 (PostgreSQL), PyMongo (MongoDB), and Redis connection utilities.
- **Logging:** Structured logging that automatically ships to the platform.

## Usage

```python
from platform_sdk import PlatformSDK

sdk = PlatformSDK(
    project_id="your-project-id",
    environment="production",
    api_url="https://api.your-platform.com"
)

# Initialize connections and register service
sdk.initialize()

# Use database connections safely
db = sdk.connections.get_postgres()
cursor = db.cursor()
cursor.execute("SELECT version();")
print(cursor.fetchone())
```
