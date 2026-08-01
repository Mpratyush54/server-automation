/**
 * Minimal Express API with Platform SDK registration + route metrics.
 *
 *   PLATFORM_URL=… PLATFORM_SDK_TOKEN=… node examples/01-express-basic.js
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
    version: '0.1.0',
  });

  const app = express();
  app.use(express.json());
  app.use(platform.expressMiddleware());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/hello', (_req, res) => {
    platform.logger.info('hello endpoint hit');
    res.json({ message: 'hello from sdk-node' });
  });

  const port = Number(process.env.PORT || 4100);
  app.listen(port, () => {
    platform.logger.info(`listening on :${port}`);
    console.log(`→ http://127.0.0.1:${port}/health`);
  });

  const stop = async () => {
    await platform.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
