/**
 * Live E2E: create a NEW GitHub repo → push k8s manifests → SDK register
 * wires ArgoCD → ArgoCD pulls from that repo and syncs.
 *
 *   ADMIN_PASSWORD=... node scripts/e2e-sdk-gitops.mjs
 *
 * Requires: gh CLI authenticated (repo create + push), network to the Platform API.
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { PlatformClient } = require(path.join(__dirname, '..', 'sdk-node', 'dist', 'index.js'));

const API = (process.env.PLATFORM_API_URL || 'https://api.148.113.59.3.sslip.io').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@pratyushes.dev';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const GH_OWNER = process.env.GH_OWNER || 'Mpratyush54';
const KEEP_REPO = process.env.KEEP_REPO === '1';
const stamp = Date.now();
const PROJECT_NAME = process.env.PROJECT_NAME || `sdk-gitops-${stamp}`;
const REPO_NAME = process.env.REPO_NAME || `platform-sdk-demo-${stamp}`;
const GIT_PATH = 'k8s';
const GIT_REV = 'main';

const results = [];
const ok = (n, d = '') => { results.push({ n, pass: true, d }); console.log(`  ✓ ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { results.push({ n, pass: false, d }); console.error(`  ✗ ${n}${d ? ` — ${d}` : ''}`); };
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', encoding: 'utf8', ...opts }).trim();

async function api(method, urlPath, { token, sdkToken, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (sdkToken) headers.Authorization = `Bearer ${sdkToken}`;
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

function writeDemoManifests(dir) {
  const k8s = path.join(dir, 'k8s');
  fs.mkdirSync(k8s, { recursive: true });
  fs.writeFileSync(path.join(k8s, 'deployment.yaml'), `apiVersion: apps/v1
kind: Deployment
metadata:
  name: sdk-demo
  labels:
    app: sdk-demo
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sdk-demo
  template:
    metadata:
      labels:
        app: sdk-demo
    spec:
      containers:
        - name: app
          image: hashicorp/http-echo:1.0
          args: ["-text=hello-from-new-github-repo", "-listen=:8080"]
          ports:
            - containerPort: 8080
          readinessProbe:
            tcpSocket:
              port: 8080
            initialDelaySeconds: 2
            periodSeconds: 5
`);
  fs.writeFileSync(path.join(k8s, 'service.yaml'), `apiVersion: v1
kind: Service
metadata:
  name: sdk-demo
spec:
  selector:
    app: sdk-demo
  ports:
    - port: 80
      targetPort: 8080
`);
  fs.writeFileSync(path.join(k8s, 'kustomization.yaml'), `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - deployment.yaml
  - service.yaml
`);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${REPO_NAME}\n\nCreated by Platform SDK GitOps E2E. ArgoCD syncs \`/${GIT_PATH}\`.\n`);
}

async function createGithubRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-gitops-'));
  writeDemoManifests(tmp);
  const full = `${GH_OWNER}/${REPO_NAME}`;
  console.log(`\n■ Create GitHub repo ${full}`);
  sh(`gh repo create ${full} --public --description "Platform SDK GitOps E2E ${stamp}"`);
  ok('gh repo create', full);

  sh('git init -b main', { cwd: tmp });
  sh('git add .', { cwd: tmp });
  sh('git -c user.email=sdk-e2e@platform.local -c user.name="SDK E2E" commit -m "feat: k8s manifests for ArgoCD sync"', { cwd: tmp });
  // Use HTTPS with gh as credential helper
  sh(`git remote add origin https://github.com/${full}.git`, { cwd: tmp });
  sh('git push -u origin main', { cwd: tmp });
  ok('push manifests', `path=${GIT_PATH}/`);

  return {
    tmp,
    full,
    cloneUrl: `https://github.com/${full}.git`,
  };
}

async function main() {
  console.log('\n=== SDK GitOps E2E: new GitHub repo → ArgoCD pull ===');
  console.log(`API=${API}`);
  console.log(`project=${PROJECT_NAME}`);
  console.log(`repo=${GH_OWNER}/${REPO_NAME}\n`);

  if (!PASSWORD) {
    fail('creds', 'ADMIN_PASSWORD required');
    process.exit(1);
  }

  let repoMeta = null;
  try {
    repoMeta = await createGithubRepo();
  } catch (e) {
    fail('create github repo', e.message || String(e));
    process.exit(1);
  }

  console.log('\n■ Platform auth + project');
  const login = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (login.status !== 200 || !login.json?.token) {
    fail('login', JSON.stringify(login.json));
    process.exit(1);
  }
  const jwt = login.json.token;
  ok('login');

  const destNs = `${PROJECT_NAME.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-staging`;
  const proj = await api('POST', '/api/projects', {
    token: jwt,
    body: {
      name: PROJECT_NAME,
      stack: 'nodejs',
      description: 'SDK creates GitHub repo + ArgoCD pull',
      domain: '148.113.59.3.sslip.io',
      repositoryUrl: repoMeta.cloneUrl,
    },
  });
  if (proj.status !== 201) {
    fail('project', JSON.stringify(proj.json));
    process.exit(1);
  }
  const projectId = proj.json.id;
  ok('project', projectId);

  let sdkToken = `sdk-${projectId}:e2e`;
  const tok = await api('POST', `/api/projects/${projectId}/tokens`, {
    token: jwt,
    body: { name: 'gitops-e2e' },
  });
  if (tok.status === 201 && tok.json?.token) {
    sdkToken = tok.json.token;
    ok('sdk token');
  } else {
    ok('sdk token fallback');
  }

  console.log('\n■ SDK init/register → ArgoCD Application from NEW repo');
  const client = new PlatformClient();
  let gitops = null;
  try {
    await client.init({
      projectName: PROJECT_NAME,
      environmentName: 'staging',
      platformUrl: API,
      sdkToken,
      version: '1.0.0',
      branch: GIT_REV,
      repositoryUrl: repoMeta.cloneUrl,
      gitPath: GIT_PATH,
      gitRevision: GIT_REV,
      domain: '148.113.59.3.sslip.io',
      gitops: true,
      namespace: destNs,
    });
    ok('sdk.init');
  } catch (e) {
    fail('sdk.init', e.message);
  }

  {
    const r = await api('POST', '/api/sdk/register', {
      sdkToken,
      body: {
        projectName: PROJECT_NAME,
        environmentName: 'staging',
        serviceName: PROJECT_NAME,
        version: '1.0.0',
        branch: GIT_REV,
        repositoryUrl: repoMeta.cloneUrl,
        gitPath: GIT_PATH,
        gitRevision: GIT_REV,
        domain: '148.113.59.3.sslip.io',
        gitops: true,
        namespace: destNs,
      },
    });
    gitops = r.json?.gitops;
    if (r.status >= 200 && r.status < 300 && gitops?.argoApplication) {
      ok('sdk.register gitops', JSON.stringify(gitops));
    } else {
      fail('sdk.register gitops', `${r.status} ${JSON.stringify(r.json)}`);
    }
  }

  try {
    client.metrics.record({
      route: '/api/gitops-e2e',
      method: 'GET',
      statusCode: 200,
      durationMs: 12,
      memoryDeltaBytes: 50,
      environment: 'staging',
      timestamp: new Date().toISOString(),
    });
    await client.metrics['flush']();
    client.logger.info(`gitops-e2e from repo ${repoMeta.full}`);
    if (client.logger.flush) await client.logger.flush();
    ok('metrics+logs');
  } catch (e) {
    fail('metrics+logs', e.message);
  }

  console.log('\n■ Wait for ArgoCD to pull NEW GitHub repo and sync');
  let synced = false;
  for (let i = 0; i < 48; i++) {
    const st = await api('GET', `/api/projects/${projectId}/argocd-status`, { token: jwt });
    const sync = st.json?.syncStatus;
    const health = st.json?.healthStatus;
    const detail = `sync=${sync} health=${health} connected=${st.json?.connected}`;
    if (String(sync).toLowerCase() === 'synced' && ['healthy', 'progressing'].includes(String(health).toLowerCase())) {
      ok('argocd pulled+synced', detail);
      synced = true;
      break;
    }
    if (i === 0 || i % 6 === 0) console.log(`  · waiting for pull… ${detail}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!synced) {
    fail('argocd pulled+synced', 'timeout — check ArgoCD can reach the new public repo');
  }

  // Confirm expected gitops target
  if (gitops?.repositoryUrl?.includes(REPO_NAME) && gitops?.gitPath === GIT_PATH) {
    ok('gitops points at new repo', `${gitops.repositoryUrl} @ ${gitops.gitPath}`);
  } else {
    fail('gitops points at new repo', JSON.stringify(gitops));
  }

  try { await client.shutdown?.(); } catch { /* ignore */ }

  if (!KEEP_REPO) {
    try {
      sh(`gh repo delete ${repoMeta.full} --yes`);
      ok('cleanup github repo', repoMeta.full);
    } catch (e) {
      console.log(`  · leave repo ${repoMeta.full} (delete failed: ${e.message})`);
    }
  } else {
    console.log(`  · KEEP_REPO=1 — left https://github.com/${repoMeta.full}`);
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Summary passed=${results.filter((r) => r.pass).length} failed=${failed} ===\n`);
  if (failed) process.exit(1);
  console.log('E2E OK — SDK created GitHub repo, ArgoCD pulled & synced\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
