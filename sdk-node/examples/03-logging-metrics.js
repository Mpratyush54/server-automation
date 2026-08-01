/**
 * Structured logs + manual metric points (no HTTP server required).
 *
 *   PLATFORM_URL=… PLATFORM_SDK_TOKEN=… node examples/03-logging-metrics.js
 */
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
  });

  platform.logger.info('example started', { pid: process.pid });
  platform.logger.warn('disk almost full (demo)', { freeMb: 128 });
  platform.logger.error('demo error', { code: 'DEMO' });

  platform.metrics.record({
    route: '/demo',
    method: 'GET',
    statusCode: 200,
    durationMs: 12,
    memoryDeltaBytes: 0,
    environment: process.env.ENVIRONMENT_NAME || 'development',
    timestamp: new Date().toISOString(),
  });

  console.log('Logs/metrics queued — check portal project Metrics / Logs');
  await new Promise((r) => setTimeout(r, 6000));
  await platform.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
