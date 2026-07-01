# MongoDB — MongoManager (Python SDK)

Manages a **pymongo** connection to MongoDB. Automatically connected when `'mongo'` is included in the `databases` list during `PlatformClient.init()`.

---

## Import

```python
from platform_sdk.db.mongo import MongoManager

# Access via client:
# client.db['mongo']
```

---

## Constructor

```python
mongo = MongoManager(config: dict = None)
```

### Config dictionary

| Key | Environment variable | Default |
|---|---|---|
| `uri` | `PLATFORM_MONGO_URI` | `mongodb://localhost:27017/platform` |

---

## Methods

### `connect()`

```python
mongo.connect() -> None
```

Creates a `pymongo.MongoClient` with a 5-second server selection timeout and runs `admin.command('ping')` to verify connectivity. Sets `self.connected = True`.

### `disconnect()`

```python
mongo.disconnect() -> None
```

Closes the MongoDB client. Sets `self.connected = False`.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `mongo.db` | `Database \| None` | The default database from the connection URI |
| `mongo.connected` | `bool` | Whether the client is connected |

---

## Auto-connect via `PlatformClient`

When `databases=['mongo']` is passed to `init()`, the manager is created and available at `client.db['mongo']` immediately after `init()` returns.

---

## Full Example

```python
from platform_sdk import PlatformClient

client = PlatformClient()
client.init(
    project_name="my-service",
    platform_url="https://platform.example.com",
    databases=["mongo"],
)

mongo = client.db["mongo"]
db = mongo.db

# Insert
db.users.insert_one({"name": "Alice", "email": "alice@example.com"})

# Query
for user in db.users.find():
    print(user)

client.shutdown()
```

---

## Error Handling

- Connection failure raises an exception — `PlatformClient.init()` catches it and logs a warning.
- `mongo.db` returns `None` if the client is not connected.
- The `ping` command is used as a health check during `connect()`.
