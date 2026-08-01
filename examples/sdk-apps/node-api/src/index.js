/**
 * Platform SDK demo — Node/Express API
 * Sends heartbeats + per-route API latency to the platform.
 * On init: GitOps register + ensure/init project DBs via SDK.
 *
 * Env:
 *   PLATFORM_URL          default https://api.148.113.59.3.sslip.io
 *   PLATFORM_SDK_TOKEN    required (project SDK token)
 *   PROJECT_NAME          default sdk-demo-apps
 *   ENVIRONMENT_NAME      default development
 *   REPOSITORY_URL        GitOps source repo
 *   GIT_PATH              default examples/sdk-apps/k8s
 *   PROJECT_DOMAIN        default 148.113.59.3.sslip.io
 *   PORT                  default 4100
 */
const express = require('express');
const cors = require('cors');
const path = require('path');

let mod;
try {
  mod = require('@mpratyush54/sdk-node');
} catch {
  mod = require(path.join(__dirname, '../../../sdk-node/dist/index.js'));
}
const platform = mod.default || (mod.PlatformClient ? new mod.PlatformClient() : mod);

const PORT = Number(process.env.PORT || 4100);
const PLATFORM_URL = (process.env.PLATFORM_URL || 'https://api.148.113.59.3.sslip.io').replace(/\/$/, '');
const PROJECT_NAME = process.env.PROJECT_NAME || 'sdk-demo-apps';
const ENVIRONMENT_NAME = process.env.ENVIRONMENT_NAME || 'development';
const SDK_TOKEN = process.env.PLATFORM_SDK_TOKEN || process.env.SDK_TOKEN || '';
const REPOSITORY_URL =
  process.env.REPOSITORY_URL ||
  'https://github.com/Mpratyush54/SERVER-automation.git';
const GIT_PATH = process.env.GIT_PATH || 'examples/sdk-apps/k8s';
const PROJECT_DOMAIN = process.env.PROJECT_DOMAIN || '148.113.59.3.sslip.io';

async function main() {
  if (!SDK_TOKEN) {
    console.error('[node-api] PLATFORM_SDK_TOKEN is required');
    process.exit(1);
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  await platform.init({
    projectName: PROJECT_NAME,
    environmentName: ENVIRONMENT_NAME,
    platformUrl: PLATFORM_URL,
    sdkToken: SDK_TOKEN,
    version: process.env.APP_VERSION || '1.0.0',
    branch: process.env.GIT_BRANCH || 'main',
    domain: PROJECT_DOMAIN,
    repositoryUrl: REPOSITORY_URL,
    gitPath: GIT_PATH,
    gitops: process.env.GITOPS !== '0',
    serviceName: 'sdk-node-api',
    servicePort: 80,
    databases: ['postgres', 'mongo', 'redis'],
  });

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(platform.expressMiddleware());

  app.get('/health', (_req, res) =>
    res.json({ ok: true, service: 'node-api', project: PROJECT_NAME }),
  );

  app.get('/api/db-check', async (_req, res) => {
    const result = {
      postgres: { connected: !!(platform.db.postgres && platform.db.postgres.isConnected) },
      mongo: { connected: !!(platform.db.mongo && platform.db.mongo.isConnected) },
      redis: { connected: !!(platform.db.redis && platform.db.redis.isConnected) },
    };
    try {
      if (platform.db.postgres && platform.db.postgres.isConnected) {
        await platform.db.postgres.query('SELECT 1 AS ok');
        result.postgres.ok = true;
      }
    } catch (e) {
      result.postgres.error = e.message;
    }
    try {
      if (platform.db.mongo && platform.db.mongo.isConnected && platform.db.mongo.db) {
        await platform.db.mongo.db.db.admin().ping();
        result.mongo.ok = true;
      }
    } catch (e) {
      result.mongo.error = e.message;
    }
    try {
      if (platform.db.redis && platform.db.redis.isConnected) {
        await platform.db.redis.set('_platform_ping', '1', 10);
        const v = await platform.db.redis.get('_platform_ping');
        result.redis.ok = v === '1';
      }
    } catch (e) {
      result.redis.error = e.message;
    }
    const allOk =
      result.postgres.connected &&
      result.mongo.connected &&
      result.redis.connected &&
      !result.postgres.error &&
      !result.mongo.error &&
      !result.redis.error;
    res.status(allOk ? 200 : 503).json({ ok: allOk, ...result });
  });

  app.get('/api/hello', (req, res) => {
    res.json({
      message: 'hello from node-api',
      client: req.query.client || null,
      at: new Date().toISOString(),
    });
  });

  app.get('/api/users', (_req, res) => {
    res.json([
      { id: 1, name: 'Ada', role: 'admin' },
      { id: 2, name: 'Grace', role: 'developer' },
    ]);
  });

  app.post('/api/orders', (req, res) => {
    const body = req.body || {};
    res.status(201).json({ id: Date.now(), ...body, status: 'created' });
  });

  app.get('/api/slow', async (_req, res) => {
    await new Promise((r) => setTimeout(r, 120));
    res.json({ slow: true });
  });

  app.listen(PORT, () => {
    console.log(
      `[node-api] listening on :${PORT} → platform ${PLATFORM_URL} project=${PROJECT_NAME} dbs=postgres,mongo,redis`,
    );
  });
}

main().catch((err) => {
  console.error('[node-api] fatal', err);
  process.exit(1);
});
