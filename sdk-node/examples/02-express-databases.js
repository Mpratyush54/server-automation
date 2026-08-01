/**
 * Express + platform-managed Postgres / Mongo / Redis.
 *
 * Platform ensures DBs on register when databases[] is set.
 *
 *   PLATFORM_URL=… PLATFORM_SDK_TOKEN=… node examples/02-express-databases.js
 */
const express = require('express');
const path = require('path');

let mod;
try {
  mod = require('@mpratyush54/sdk-node');
} catch {
  mod = require(path.join(__dirname, '../dist/index.js'));
}
const platform = mod.default || new mod.PlatformClient();

async function main() {
  const token = process.env.PLATFORM_SDK_TOKEN || process.env.SDK_TOKEN;
  if (!token) {
    console.error('Set PLATFORM_SDK_TOKEN');
    process.exit(1);
  }

  await platform.init({
    projectName: process.env.PROJECT_NAME || 'sdk-examples',
    platformUrl: (process.env.PLATFORM_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sdkToken: token,
    environmentName: process.env.ENVIRONMENT_NAME || 'development',
    databases: ['postgres', 'mongo', 'redis'],
  });

  const app = express();
  app.use(platform.expressMiddleware());

  app.get('/api/db-check', async (_req, res) => {
    const out = {
      postgres: { connected: !!(platform.db.postgres && platform.db.postgres.isConnected) },
      mongo: { connected: !!(platform.db.mongo && platform.db.mongo.isConnected) },
      redis: { connected: !!(platform.db.redis && platform.db.redis.isConnected) },
    };

    try {
      if (platform.db.postgres?.isConnected) {
        const r = await platform.db.postgres.query('SELECT 1 AS ok');
        out.postgres.sample = r.rows[0];
      }
    } catch (e) {
      out.postgres.error = String(e.message || e);
    }

    try {
      if (platform.db.redis?.isConnected) {
        await platform.db.redis.set('sdk-examples:ping', '1', 60);
        out.redis.sample = await platform.db.redis.get('sdk-examples:ping');
      }
    } catch (e) {
      out.redis.error = String(e.message || e);
    }

    res.json(out);
  });

  const port = Number(process.env.PORT || 4101);
  app.listen(port, () => console.log(`→ http://127.0.0.1:${port}/api/db-check`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
