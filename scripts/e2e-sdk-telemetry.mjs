/**
 * E2E: create project + SDK token, run node-api with SDK, generate React/Angular-style traffic,
 * then verify Telemetry (heartbeats + API latency) via the platform API.
 *
 * Usage:
 *   $env:NODE_TLS_REJECT_UNAUTHORIZED='0'
 *   $env:ADMIN_PASSWORD='…'
 *   node scripts/e2e-sdk-telemetry.mjs
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const API = (process.env.PLATFORM_API_URL || 'https://api.148.113.59.3.sslip.io').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@pratyushes.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PROJECT_NAME = process.env.PROJECT_NAME || `sdk-telemetry-${Date.now()}`;
const NODE_PORT = Number(process.env.NODE_PORT || 4100);

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD required');
  process.exit(1);
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function api(method, urlPath, body, token) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status} ${text.slice(0, 300)}`);
  return data;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function hitLocal(pathname, opts) {
  const res = await fetch(`http://127.0.0.1:${NODE_PORT}${pathname}`, opts);
  return res.status;
}

async function main() {
  console.log('[1] login');
  const login = await api('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const token = login.token;

  console.log('[2] create project', PROJECT_NAME);
  let project;
  try {
    project = await api('POST', '/api/projects', {
      name: PROJECT_NAME,
      stack: 'nodejs',
      repositoryUrl: 'https://github.com/Mpratyush54/SERVER-automation.git',
      domain: '148.113.59.3.sslip.io',
    }, token);
  } catch (e) {
    // may already exist
    const all = await api('GET', '/api/projects', null, token);
    project = all.find((p) => p.name === PROJECT_NAME);
    if (!project) throw e;
  }

  console.log('[3] create SDK token');
  const tok = await api('POST', `/api/projects/${project.id}/tokens`, { name: 'telemetry-e2e' }, token);
  const sdkToken = tok.token || tok.plaintext || tok.key;
  if (!sdkToken) throw new Error('No SDK token in response: ' + JSON.stringify(tok));

  // Ensure SDK is built
  const sdkDist = path.join(root, 'sdk-node', 'dist', 'index.js');
  if (!fs.existsSync(sdkDist)) {
    console.log('[4] building sdk-node…');
    await new Promise((resolve, reject) => {
      const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
        cwd: path.join(root, 'sdk-node'),
        stdio: 'inherit',
        shell: true,
      });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('sdk build failed'))));
    });
  }

  console.log('[5] install + start node-api');
  const nodeDir = path.join(root, 'examples', 'sdk-apps', 'node-api');
  await new Promise((resolve, reject) => {
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], {
      cwd: nodeDir, stdio: 'inherit', shell: true,
    });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('npm install failed'))));
  });

  const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', ['src/index.js'], {
    cwd: nodeDir,
    env: {
      ...process.env,
      PLATFORM_SDK_TOKEN: sdkToken,
      PLATFORM_URL: API,
      PROJECT_NAME,
      ENVIRONMENT_NAME: 'development',
      PORT: String(NODE_PORT),
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[node-api] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[node-api] ${d}`));

  // wait for listen
  for (let i = 0; i < 30; i++) {
    try {
      await hitLocal('/health');
      break;
    } catch {
      await wait(500);
    }
    if (i === 29) throw new Error('node-api did not start');
  }

  console.log('[6] generate React + Angular style traffic');
  for (let i = 0; i < 8; i++) {
    await hitLocal('/api/hello?client=react');
    await hitLocal('/api/users?client=angular');
    await hitLocal('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: 'e2e', n: i }),
    });
    await hitLocal('/api/slow?client=react');
  }

  console.log('[7] wait for SDK flush / heartbeats…');
  await wait(20000);

  console.log('[8] verify telemetry');
  const metrics = await api('GET', `/api/metrics?projectId=${project.id}`, null, token);
  const agg = await api('GET', `/api/metrics/aggregated?projectId=${project.id}`, null, token);
  const apiMetrics = await api('GET', `/api/sdk/api-metrics?projectId=${project.id}`, null, token);

  const heartbeats = Array.isArray(metrics) ? metrics.length : 0;
  const routes = apiMetrics?.metrics?.length || 0;

  console.log(JSON.stringify({
    projectId: project.id,
    projectName: PROJECT_NAME,
    heartbeats,
    cpuAvg: agg?.cpuAvg,
    memoryAvg: agg?.memoryAvg,
    apiRoutes: routes,
    sampleRoutes: (apiMetrics?.metrics || []).slice(0, 5).map((m) => ({
      method: m._id?.method, route: m._id?.route, count: m.count, avg: m.avgDuration,
    })),
  }, null, 2));

  child.kill('SIGTERM');

  if (heartbeats < 1 && routes < 1) {
    console.error('FAIL: no telemetry received');
    process.exit(2);
  }
  console.log('PASS: telemetry flowing (open portal → Metrics / API Latency)');
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E failed:', err.message);
  process.exit(1);
});
