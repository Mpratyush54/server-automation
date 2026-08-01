# Node.js SDK Quickstart

Instrument a Node.js service with registration, heartbeats, route metrics, logging, and optional managed databases.

Package: [`@mpratyush54/sdk-node`](https://www.npmjs.com/package/@mpratyush54/sdk-node) · Source examples: [`sdk-node/examples`](../../sdk-node/examples)

## Installation

```bash
npm install @mpratyush54/sdk-node
```

## Basic usage

```js
import platform from '@mpratyush54/sdk-node';
import express from 'express';

await platform.init({
  projectName: 'my-api',
  platformUrl: process.env.PLATFORM_URL,       // https://api.…sslip.io
  sdkToken: process.env.PLATFORM_SDK_TOKEN,    // Project → Tokens
  environmentName: 'development',
});

const app = express();
app.use(platform.expressMiddleware()); // latency → portal Metrics

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(4100);

platform.logger.info('listening');
```

Create a **project** and **SDK token** in the portal first. The server assigns the K8s namespace as `{project}-{environment}` — you cannot override it from the client.

## Databases

Pass `databases: ['postgres','mongo','redis']` to have the platform ensure credentials and connect managers:

```js
await platform.init({
  projectName: 'my-api',
  platformUrl: process.env.PLATFORM_URL,
  sdkToken: process.env.PLATFORM_SDK_TOKEN,
  databases: ['postgres', 'mongo', 'redis'],
});

const { rows } = await platform.db.postgres.query('SELECT 1 AS ok');
await platform.db.redis.set('hello', 'world', 60);
```

## Logging

```js
platform.logger.info('started', { version: '1.0.0' });
platform.logger.warn('slow query');
platform.logger.error('failed', { err: String(e) });
```

Optional: `platform.captureConsole()` forwards `console.*` — avoid combining with transports that also write to console (recursion). Prefer `platform.logger` in APIs.

Winston / Pino:

```js
import { createWinstonTransport, createPinoTransport } from '@mpratyush54/sdk-node';
```

## GitOps register

When `repositoryUrl` matches the project’s configured repo, `init()` can refresh ArgoCD:

```js
await platform.init({
  projectName: 'sdk-demo-apps',
  platformUrl: process.env.PLATFORM_URL,
  sdkToken: process.env.PLATFORM_SDK_TOKEN,
  repositoryUrl: 'https://github.com/org/repo.git',
  gitPath: 'k8s',
  gitRevision: 'main',
  gitops: true,
  domain: '148.113.59.3.sslip.io',
  serviceName: 'my-api',
  servicePort: 80,
  databases: ['postgres', 'mongo', 'redis'],
});
```

A mismatched SDK git origin returns **409**.

## Options cheat sheet

| Option | Description |
|--------|-------------|
| `projectName` / `platformUrl` | Required |
| `sdkToken` | Or `PLATFORM_SDK_TOKEN` |
| `environmentName` | Default `development` |
| `databases` | `postgres` · `mongo` · `redis` |
| `repositoryUrl` / `gitPath` / `gitRevision` | GitOps |
| `domain` / `serviceName` / `servicePort` | Ingress |

## More examples

| Path | Topic |
|------|--------|
| [`sdk-node/examples/01-express-basic.js`](../../sdk-node/examples/01-express-basic.js) | Health + middleware |
| [`sdk-node/examples/02-express-databases.js`](../../sdk-node/examples/02-express-databases.js) | DB check route |
| [`sdk-node/examples/03-logging-metrics.js`](../../sdk-node/examples/03-logging-metrics.js) | Logger + `metrics.record` |
| [`sdk-node/examples/04-gitops-register.js`](../../sdk-node/examples/04-gitops-register.js) | GitOps fields |
| [`examples/sdk-apps`](../../examples/sdk-apps) | Full Node/React/Angular demo on cluster |

## API reference

[PlatformClient](../api-reference/sdk-node/PlatformClient.md) · [expressMiddleware](../api-reference/sdk-node/expressMiddleware.md) · [Postgres](../api-reference/sdk-node/db-postgres.md) · [Mongo](../api-reference/sdk-node/db-mongo.md) · [Redis](../api-reference/sdk-node/db-redis.md)
