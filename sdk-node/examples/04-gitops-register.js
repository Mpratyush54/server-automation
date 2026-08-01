/**
 * Register with GitOps fields so the platform creates/refreshes ArgoCD.
 * repositoryUrl MUST match the project's repository URL in the portal.
 *
 *   PLATFORM_URL=… PLATFORM_SDK_TOKEN=… REPOSITORY_URL=… node examples/04-gitops-register.js
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
  const repositoryUrl = process.env.REPOSITORY_URL;
  if (!token || !repositoryUrl) {
    console.error('Set PLATFORM_SDK_TOKEN and REPOSITORY_URL');
    process.exit(1);
  }

  await platform.init({
    projectName: process.env.PROJECT_NAME || 'sdk-demo-apps',
    platformUrl: (process.env.PLATFORM_URL || 'http://localhost:3000').replace(/\/$/, ''),
    sdkToken: token,
    environmentName: process.env.ENVIRONMENT_NAME || 'development',
    repositoryUrl,
    gitPath: process.env.GIT_PATH || 'examples/sdk-apps/k8s',
    gitRevision: process.env.GIT_REVISION || 'main',
    domain: process.env.PROJECT_DOMAIN,
    gitops: true,
    serviceName: process.env.SERVICE_NAME || 'sdk-node-api',
    servicePort: Number(process.env.SERVICE_PORT || 80),
    databases: ['postgres', 'mongo', 'redis'],
  });

  console.log('Registered. Namespace is server-assigned; check portal Environments + ArgoCD.');
  await platform.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
