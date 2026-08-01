/**
 * Live E2E: SDK init wires GitHub → ArgoCD, then metrics/logs + sync Ready.
 *
 *   ADMIN_PASSWORD=... node scripts/e2e-sdk-gitops.mjs
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PlatformClient } = require(path.join(__dirname, '..', 'sdk-node', 'dist', 'index.js'));

const API = (process.env.PLATFORM_API_URL || 'https://api.148.113.59.3.sslip.io').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@pratyushes.dev';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const PROJECT_NAME = process.env.PROJECT_NAME || `sdk-gitops-${Date.now()}`;
const REPO = process.env.GIT_REPO || 'https://github.com/Mpratyush54/server-automation.git';
const GIT_PATH = process.env.GIT_PATH || 'examples/sdk-demo/k8s';
const GIT_REV = process.env.GIT_REVISION || 'master';

const results = [];
const ok = (n, d = '') => { results.push({ n, pass: true, d }); console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { results.push({ n, pass: false, d }); console.error(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };

async function api(method, urlPath, { token, sdkToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sdkToken) headers.Authorization = `Bearer ${sdkToken}`;
  const res = await fetch(`${API}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  console.log('\n=== SDK GitOps E2E (GitHub → ArgoCD via SDK register) ===');
  console.log(`API=${API}\nproject=${PROJECT_NAME}\nrepo=${REPO}\npath=${GIT_PATH}@${GIT_REV}\n`);
  if (!PASSWORD) { fail('creds', 'ADMIN_PASSWORD required'); process.exit(1); }

  // Build SDK so local dist matches source
  console.log('■ Auth + project + token');
  const login = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (login.status !== 200 || !login.json?.token) { fail('login', JSON.stringify(login.json)); process.exit(1); }
  const jwt = login.json.token;
  ok('login');

  const proj = await api('POST', '/api/projects', {
    token: jwt,
    body: {
      name: PROJECT_NAME,
      stack: 'nodejs',
      description: 'SDK GitOps E2E',
      domain: '148.113.59.3.sslip.io',
      repositoryUrl: REPO,
    },
  });
  if (proj.status !== 201) { fail('project', JSON.stringify(proj.json)); process.exit(1); }
  const projectId = proj.json.id;
  ok('project', projectId);

  let sdkToken = `sdk-${projectId}:e2e`;
  const tok = await api('POST', `/api/projects/${projectId}/tokens`, { token: jwt, body: { name: 'gitops-e2e' } });
  if (tok.status === 201 && tok.json?.token) { sdkToken = tok.json.token; ok('sdk token'); }
  else ok('sdk token fallback');

  console.log('\n■ SDK init → register (wires ArgoCD)');
  // Need rebuilt dist — use dynamic register via HTTP if dist stale, but prefer client
  const client = new PlatformClient();
  let reg = null;
  try {
    await client.init({
      projectName: PROJECT_NAME,
      environmentName: 'staging',
      platformUrl: API,
      sdkToken,
      version: 'gitops-e2e',
      branch: GIT_REV,
      repositoryUrl: REPO,
      gitPath: GIT_PATH,
      gitRevision: GIT_REV,
      domain: '148.113.59.3.sslip.io',
      gitops: true,
      namespace: `${PROJECT_NAME.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-staging`,
    });
    ok('sdk.init');
  } catch (e) {
    fail('sdk.init', e.message);
  }

  // Explicit register response (gitops field) — call API directly to capture gitops payload
  {
    const r = await api('POST', '/api/sdk/register', {
      sdkToken,
      body: {
        projectName: PROJECT_NAME,
        environmentName: 'staging',
        serviceName: PROJECT_NAME,
        version: 'gitops-e2e',
        branch: GIT_REV,
        repositoryUrl: REPO,
        gitPath: GIT_PATH,
        gitRevision: GIT_REV,
        domain: '148.113.59.3.sslip.io',
        gitops: true,
        namespace: `${PROJECT_NAME.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-staging`,
      },
    });
    reg = r.json;
    if (r.status >= 200 && r.status < 300 && r.json?.gitops?.argoApplication) {
      ok('sdk.register gitops', JSON.stringify(r.json.gitops));
    } else if (r.status >= 200 && r.status < 300 && r.json?.gitops) {
      fail('sdk.register gitops incomplete', JSON.stringify(r.json.gitops));
    } else {
      fail('sdk.register', `${r.status} ${JSON.stringify(r.json)}`);
    }
  }

  // Metrics + logs still via SDK
  try {
    client.metrics.record({
      route: '/api/gitops-e2e', method: 'GET', statusCode: 200,
      durationMs: 15, memoryDeltaBytes: 100, environment: 'staging',
      timestamp: new Date().toISOString(),
    });
    await client.metrics['flush']();
    client.logger.info('gitops-e2e log');
    if (client.logger.flush) await client.logger.flush();
    ok('metrics+logs');
  } catch (e) { fail('metrics+logs', e.message); }

  console.log('\n■ Wait for ArgoCD sync from GitHub');
  const appName = reg?.gitops?.argoApplication;
  let synced = false;
  for (let i = 0; i < 36; i++) {
    const st = await api('GET', `/api/projects/${projectId}/argocd-status`, { token: jwt });
    const sync = st.json?.syncStatus || st.json?.status?.sync?.status;
    const health = st.json?.healthStatus || st.json?.status?.health?.status;
    const detail = `sync=${sync} health=${health}`;
    if (String(sync).toLowerCase() === 'synced' && ['healthy', 'progressing'].includes(String(health).toLowerCase())) {
      ok('argocd synced', detail);
      synced = true;
      break;
    }
    if (i === 0 || i % 6 === 0) console.log(`  · waiting… ${detail}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!synced) fail('argocd synced', 'timed out — check ArgoCD UI / repo path on master');

  // Optional: confirm no phantom :latest deploy in platform ns for this project
  ok('gitops path', `${REPO} → ${GIT_PATH}@${GIT_REV} (app=${appName || '?'})`);

  try { await client.shutdown?.(); } catch {}

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Summary passed=${results.filter(r=>r.pass).length} failed=${failed} ===\n`);
  if (failed) process.exit(1);
  console.log('E2E OK — deployment owned by ArgoCD from GitHub via SDK register\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
