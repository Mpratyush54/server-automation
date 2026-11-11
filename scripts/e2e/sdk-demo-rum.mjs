// node sdk-demo-rum.mjs
// Configures browser telemetry for the sdk-demo-apps project and writes the
// Secret sdk-demo-rum that the React/Angular demo deployments read (RUM_* env):
//   faroEndpoint, browserToken, replayEndpoint, heatmapsEndpoint, heatmapsToken,
//   errorsEndpoint
// Steps: allow the demo origins (TELEMETRY_ALLOWED_ORIGINS on the development
// environment), read the telemetry block from GET /api/sdk/config with a server
// SDK token (the browser ingest token there carries those origins), mint (or
// rotate) one browser-kind SDK token for heatmaps, then
// `kubectl apply` the Secret from stdin. Idempotent: re-running replaces the
// browser token of the same name and re-applies the Secret.
//
// Env: PROJECT_ID, SDK_TOKEN_FILE (server-kind SDK token), E2E_DOMAIN,
// PLATFORM_URL, and E2E_ADMIN_TOKEN (admin session; falls back to a fresh
// adminSession login). Token values are never printed or passed on argv.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { adminSession, apiUrl, domain, env, request } from './checks/common.mjs';

const NS = 'sdk-demo-apps-development';
const SECRET = 'sdk-demo-rum';
const BROWSER_TOKEN_NAME = 'e2e-sdk-demo-rum-browser';

function fail(msg) {
  console.error(`sdk-demo-rum: ${msg}`);
  process.exit(1);
}

const projectId = env('PROJECT_ID');
const serverToken = readFileSync(env('SDK_TOKEN_FILE'), 'utf8').trim();
if (!serverToken) fail('SDK_TOKEN_FILE is empty');
const d = domain();
const adminToken = process.env.E2E_ADMIN_TOKEN || (await adminSession({ log: (m) => console.error(`  ..   ${m}`) })).token;
const admin = (p, o = {}) =>
  request(`${apiUrl()}/api${p}`, { ...o, headers: { authorization: `Bearer ${adminToken}`, ...(o.headers || {}) } });

const proj = await admin(`/projects/${encodeURIComponent(projectId)}`);
if (proj.status !== 200) fail(`GET project -> HTTP ${proj.status}`);
const devEnv = ((proj.json?.project || proj.json)?.environments || []).find((e) => e.name === 'development');
if (!devEnv) fail('project has no development environment');

const origins = `https://sdk-react.${d},https://sdk-angular.${d}`;
const put = await admin(`/projects/${projectId}/environment/TELEMETRY_ALLOWED_ORIGINS`, {
  method: 'PUT', body: { environmentId: devEnv.id, value: origins, secret: false },
});
if (put.status >= 300) fail(`setting TELEMETRY_ALLOWED_ORIGINS -> HTTP ${put.status}`);

const cfg = await request(`${apiUrl()}/api/sdk/config?projectId=${projectId}&environmentId=${devEnv.id}`, {
  headers: { authorization: `Bearer ${serverToken}` },
});
if (cfg.status !== 200) fail(`GET /api/sdk/config -> HTTP ${cfg.status}`);
const t = cfg.json?.telemetry || {};
if (!t.faroEndpoint || !t.browserToken) {
  // Lighter profiles have no RUM collector; the demos then run with RUM off.
  console.log('     telemetry block has no Faro endpoint/browser token; sdk-demo-rum not written (RUM stays off)');
  process.exit(0);
}

// One browser token per project: drop earlier ones of this name before minting.
const tokens = await admin(`/projects/${projectId}/tokens`);
if (tokens.status !== 200 || !Array.isArray(tokens.json)) fail(`listing SDK tokens -> HTTP ${tokens.status}`);
for (const old of tokens.json.filter((x) => x.name === BROWSER_TOKEN_NAME)) {
  const del = await admin(`/projects/${projectId}/tokens/${old.id}`, { method: 'DELETE' });
  if (del.status >= 300 && del.status !== 404) fail(`revoking old browser token -> HTTP ${del.status}`);
}
const minted = await admin(`/projects/${projectId}/tokens`, { method: 'POST', body: { name: BROWSER_TOKEN_NAME, kind: 'browser' } });
const browserSdkToken = minted.json?.token;
if (minted.status !== 201 || !browserSdkToken) fail(`minting browser token -> HTTP ${minted.status}`);

const data = {
  faroEndpoint: t.faroEndpoint,
  browserToken: t.browserToken,
  replayEndpoint: t.replayEndpoint || `https://${d}/api/sdk/replay`,
  heatmapsEndpoint: t.heatmapsEndpoint || `https://${d}/api/sdk/heatmap/events`,
  heatmapsToken: browserSdkToken,
  errorsEndpoint: t.errorsEndpoint || `https://${d}/api/errors/rum`,
};
const secret = {
  apiVersion: 'v1',
  kind: 'Secret',
  type: 'Opaque',
  metadata: { name: SECRET, namespace: NS, labels: { 'app.kubernetes.io/part-of': 'sdk-demo-apps' } },
  stringData: data,
};
try {
  execFileSync('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(secret), stdio: ['pipe', 'ignore', 'inherit'] });
} catch (e) {
  fail(`kubectl apply of Secret ${SECRET} failed (exit ${e.status ?? '?'})`);
}
console.log(`     Secret ${NS}/${SECRET} applied (${Object.keys(data).join(', ')})`);
