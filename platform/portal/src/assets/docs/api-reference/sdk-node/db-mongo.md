# MongoDB — MongoManager

Manages a **Mongoose** connection to MongoDB. Automatically connected when `'mongo'` is included in the `databases` array during `PlatformClient.init()`.

---

## Import

```typescript
import { MongoManager } from '@mpratyush54/sdk-node';

// Access via client:
// client.db.mongo
```

---

## Constructor

```typescript
const mongo = new MongoManager(config?: MongoConfig);
```

### `MongoConfig`

| Field | Environment variable | Default |
|---|---|---|
| `uri` | `PLATFORM_MONGO_URI` | `mongodb://localhost:27017/platform` |

---

## Methods

### `connect()`

```typescript
await mongo.connect(): Promise<void>
```

Creates a Mongoose connection via `mongoose.createConnection(uri)` and waits for it to be ready. On failure, schedules automatic reconnection with exponential backoff (up to 5 retries, max 30 s delay).

### `disconnect()`

```typescript
await mongo.disconnect(): Promise<void>
```

Closes the Mongoose connection.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `mongo.db` | `Connection \| null` | The raw Mongoose `Connection` object (use to define models) |
| `mongo.isConnected` | `boolean` | Whether the connection is active |
| `mongo.health` | `{ connected }` | Health-check summary |

---

## Auto-connect via `PlatformClient`

When `databases: ['mongo']` is passed to `init()`, credentials are fetched automatically from the Platform API (`GET /api/sdk/db-credentials`), and the manager is available at `client.db.mongo` immediately after `init()` resolves.

---

## Full Example

```typescript
import { PlatformClient } from '@mpratyush54/sdk-node';
import { Schema, model } from 'mongoose';

const client = new PlatformClient();

async function main() {
  await client.init({
    projectName: 'my-service',
    platformUrl: 'https://platform.example.com',
    databases: ['mongo'],
  });

  const conn = client.db.mongo!.db!;

  // Define a model on the SDK-managed connection
  const UserSchema = new Schema({
    name: String,
    email: { type: String, unique: true },
  });
  const User = conn.model('User', UserSchema);

  // Create
  const alice = await User.create({ name: 'Alice', email: 'alice@example.com' });
  console.log('Created:', alice);

  // Query
  const users = await User.find();
  console.log('Users:', users);

  await client.shutdown();
}

main();
```

---

## Error Handling

- Connection failure is **non-blocking** — `isConnected` remains `false`.
- Exponential backoff reconnection is attempted automatically (5 retries max).
- `db` returns `null` if not connected — guard with `mongo.isConnected` or optional chaining.
