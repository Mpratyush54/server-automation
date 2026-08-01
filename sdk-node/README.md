# @mpratyush54/sdk-node

Official Node.js SDK for Platform — auto-registration, GitOps, metrics, logging, config, storage, and managed DB connections.

**Requires Node.js ≥ 18.** Package: [`@mpratyush54/sdk-node`](https://www.npmjs.com/package/@mpratyush54/sdk-node)

## Install

```bash
npm install @mpratyush54/sdk-node
```

## Quick start

```js
import platform from '@mpratyush54/sdk-node';
// or: import { PlatformClient } from '@mpratyush54/sdk-node'; const platform = new PlatformClient();

await platform.init({
  projectName: 'my-api',
  platformUrl: process.env.PLATFORM_URL,      // e.g. https://api.example.sslip.io
  sdkToken: process.env.PLATFORM_SDK_TOKEN,   // Project → Tokens
  environmentName: process.env.ENVIRONMENT_NAME || 'development',
  databases: ['postgres', 'mongo', 'redis'],  // optional — platform ensures DBs
});

const app = express();
app.use(platform.expressMiddleware()); // per-route latency → portal

platform.logger.info('ready');
```

## What `init()` does

1. **Register** the service (`POST /api/sdk/register`)
2. Optionally wire **GitOps** (ArgoCD) when `repositoryUrl` is set — SDK git origin must match the project repo
3. **Ensure** Postgres / Mongo / Redis credentials for the project environment
4. Start **heartbeats** (CPU, memory, uptime, DB health)
5. Load **remote config** and refresh in the background
6. Connect DB managers listed in `databases`

The Kubernetes **namespace is assigned by the server** (`{project}-{environment}`). Client `namespace` is ignored.

## Options (`PlatformOptions`)

| Option | Required | Description |
|--------|----------|-------------|
| `projectName` | yes | Platform project name |
| `platformUrl` | yes | API base URL |
| `sdkToken` | no* | Bearer token (`PLATFORM_SDK_TOKEN` env fallback) |
| `environmentName` | no | Default `development` |
| `version` / `branch` / `commitSha` | no | Build metadata |
| `databases` | no | `['postgres','mongo','redis']` |
| `repositoryUrl` | no | Must match project `repositoryUrl` for GitOps |
| `gitPath` / `gitRevision` | no | Manifest path + revision for ArgoCD |
| `domain` / `serviceName` / `servicePort` | no | Ingress wiring |
| `gitops` | no | Prefer GitOps path when repo is set |

\*Required for authenticated register / DB ensure / metrics on secured APIs.

## Features

### Express / Fastify-style middleware

```js
app.use(platform.expressMiddleware());
```

### Logging

```js
platform.logger.info('hello', { userId: 1 });
platform.logger.warn('slow');
platform.logger.error('failed', { err: String(e) });
```

Optional Winston / Pino transports:

```js
import { createWinstonTransport, createPinoTransport } from '@mpratyush54/sdk-node';
```

### Console capture

```js
platform.captureConsole(); // forwards console.* → platform logs
```

Avoid `captureConsole()` together with transports that also write to `console` (recursion). Prefer `platform.logger` in production APIs.

### Databases

```js
const { rows } = await platform.db.postgres.query('SELECT 1 AS ok');
await platform.db.mongo.db.collection('items').findOne({}); // mongoose Connection
await platform.db.redis.set('k', 'v', 60);
```

Managers: `PostgresManager`, `MongoManager`, `RedisManager` (also exported).

### Config & storage

```js
const flag = platform.config('FEATURE_X', false);
await platform.storage.upload(/* … */);
```

### Shutdown

```js
process.on('SIGTERM', () => platform.shutdown());
```

## Examples

Runnable snippets live in [`examples/`](./examples/):

| File | Topic |
|------|--------|
| [`01-express-basic.js`](./examples/01-express-basic.js) | Init + middleware + health |
| [`02-express-databases.js`](./examples/02-express-databases.js) | Postgres / Mongo / Redis |
| [`03-logging-metrics.js`](./examples/03-logging-metrics.js) | Logger + custom metrics |
| [`04-gitops-register.js`](./examples/04-gitops-register.js) | GitOps register options |

End-to-end demo apps (Node + React + Angular on cluster): [`examples/sdk-apps/`](../examples/sdk-apps/).

Docs: [Node quickstart](../docs/getting-started/node-sdk-quickstart.md) · [PlatformClient API](../docs/api-reference/sdk-node/PlatformClient.md)

## Env vars

| Variable | Purpose |
|----------|---------|
| `PLATFORM_URL` | API base (your convention) |
| `PLATFORM_SDK_TOKEN` | Default for `sdkToken` |
| `PLATFORM_PG_*` / `PLATFORM_MONGO_*` / `PLATFORM_REDIS_*` | Optional local DB overrides |

## License

MIT
