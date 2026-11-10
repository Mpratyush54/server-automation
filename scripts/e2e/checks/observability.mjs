// node observability.mjs scoping
// Observability query proxies (#48): unauthenticated calls are refused,
// queries that try to override or escape the project filter are refused, a
// member of project A cannot query project B, and scoped queries reach the
// backends. Full profile only (telemetry backends installed).
import { randomBytes } from 'node:crypto';
import { adminSession, apiUrl, domain, expect, login, main, ok, request } from './common.mjs';

const mode = process.argv[2];

async function createProject(auth, label) {
  const name = `e2e-obs-${label}-${Date.now().toString(36)}`;
  const r = await request(`${apiUrl()}/api/projects`, { method: 'POST', headers: auth, body: { name, stack: 'nodejs', domain: domain(), description: 'e2e observability scoping', repositoryUrl: 'https://github.com/Mpratyush54/server-automation' } });
  if (!expect(r.status === 201 && r.json?.id, `create project ${label}`, `HTTP ${r.status}`)) return null;
  return r.json.id;
}

async function scoping() {
  const api = apiUrl();
  const probe = '00000000-0000-4000-8000-000000000000';
  for (const path of ['/api/observability/fleet', `/api/projects/${probe}/observability/query/prom?query=up`, `/api/projects/${probe}/observability/traces/0123456789abcdef0123456789abcdef`]) {
    const r = await request(`${api}${path}`);
    expect(r.status === 401, `unauthenticated ${path.split('?')[0]} -> 401`, `HTTP ${r.status}`);
  }

  const token = await login();
  const auth = { authorization: `Bearer ${token}` };
  const status = await request(`${api}/api/observability/status`, { headers: auth });
  expect(status.status === 200 && status.json?.enabled === true, 'observability backends enabled (full profile)', `HTTP ${status.status} enabled=${status.json?.enabled}`);

  const a = await createProject(auth, 'a');
  const b = await createProject(auth, 'b');
  if (!a || !b) return;
  const base = `${api}/api/projects/${a}/observability`;
  const q = (path, params) => request(`${base}${path}?${new URLSearchParams(params)}`, { headers: auth, timeoutMs: 40000 });

  // Override / escape attempts are refused before any backend is called.
  const attacks = [
    ['/query/prom', { query: `up{platform_project_id="${b}"}` }],
    ['/query/prom', { query: 'up{platform_project_id=~".+"}' }],
    ['/query/prom', { query: `traces_spanmetrics_calls_total or traces_spanmetrics_calls_total{platform_project_id!="${a}"}` }],
    ['/query/prom', { query: 'up{job="a" or job="b"}' }],
    ['/query/loki', { query: `{platform_project_id="${b}"}` }],
    ['/query/loki', { query: '{platform_project_id=~".*"} |= "x"' }],
    ['/query/tempo', { q: '{ true) || (true }' }],
    ['/query/tempo', { q: '{ .a = 1 } // }' }],
    ['/query/pyroscope', { profileType: `cpu{platform_project_id="${b}"}` }],
  ];
  let refused = 0;
  for (const [path, params] of attacks) {
    const r = await q(path, params);
    if (r.status === 400) refused++;
    else expect(false, `override refused: ${path} ${JSON.stringify(params)}`, `HTTP ${r.status}`);
  }
  if (refused === attacks.length) ok(`project filter overrides refused (${attacks.length} queries)`);

  // Scoped queries reach every backend and carry the project matcher.
  const prom = await q('/query/prom', { query: 'sum(rate(traces_spanmetrics_calls_total[5m]))', since: '15m' });
  expect(prom.status === 200 && String(prom.json?.query).includes(`platform_project_id="${a}"`), 'Prometheus proxy scopes and answers', `HTTP ${prom.status}`);
  const loki = await q('/query/loki', { query: '{service_name=~".+"}', since: '15m', limit: '5' });
  expect(loki.status === 200 && String(loki.json?.query).includes(`platform_project_id="${a}"`), 'Loki proxy scopes and answers', `HTTP ${loki.status}`);
  const tempo = await q('/query/tempo', { q: '{}', since: '15m', limit: '5' });
  expect(tempo.status === 200 && String(tempo.json?.query).includes(`resource.platform.project_id = "${a}"`), 'Tempo proxy scopes and answers', `HTTP ${tempo.status}`);
  const prof = await q('/profiles/meta', { since: '1h' });
  expect(prof.status === 200, 'Pyroscope proxy answers', `HTTP ${prof.status}`);
  const summary = await q('/summary', { since: '1h' });
  expect(summary.status === 200 && summary.json?.telemetryEnabled === true, 'project summary', `HTTP ${summary.status}`);
  const fleet = await request(`${api}/api/observability/fleet?since=1h`, { headers: auth, timeoutMs: 60000 });
  expect(fleet.status === 200 && Array.isArray(fleet.json?.projects) && fleet.json.projects.some((p) => p.projectId === a), 'fleet lists projects (admin)', `HTTP ${fleet.status}`);

  // A developer who is only a member of A cannot query B.
  const email = `e2e-obs-${randomBytes(4).toString('hex')}@example.test`;
  const password = randomBytes(18).toString('base64url');
  const u = await request(`${api}/api/users`, { method: 'POST', headers: auth, body: { name: 'e2e observability dev', email, password, role: 'developer' } });
  if (!expect(u.status === 201 || u.status === 200, 'create developer user', `HTTP ${u.status}`)) return;
  const m = await request(`${api}/api/projects/${a}/members`, { method: 'POST', headers: auth, body: { email, role: 'developer' } });
  if (!expect(m.status === 201 || m.status === 200, 'add developer to project A', `HTTP ${m.status}`)) return;
  let dev;
  try {
    dev = (await adminSession({ email, password, stateFile: null, allowEnroll: false, fresh: true, loginAttempts: 2 })).token;
  } catch (e) {
    expect(false, 'developer login (MFA must not be required for developers)', e?.message || String(e));
    return;
  }
  const devAuth = { authorization: `Bearer ${dev}` };
  const own = await request(`${api}/api/projects/${a}/observability/query/prom?query=up`, { headers: devAuth });
  expect(own.status === 200, 'member queries own project', `HTTP ${own.status}`);
  let denied = 0;
  const cross = ['query/prom?query=up', 'query/loki?query=%7Bservice_name%3D~%22.%2B%22%7D', 'query/tempo?q=%7B%7D', 'traces/0123456789abcdef0123456789abcdef', 'query/pyroscope', 'summary', 'service-graph', 'infra'];
  for (const path of cross) {
    const r = await request(`${api}/api/projects/${b}/observability/${path}`, { headers: devAuth });
    if (r.status === 403) denied++;
    else expect(false, `member of A denied on B ${path.split('?')[0]}`, `HTTP ${r.status}`);
  }
  if (denied === cross.length) ok(`member of project A denied on project B (${cross.length} endpoints)`);
  const devFleet = await request(`${api}/api/observability/fleet`, { headers: devAuth, timeoutMs: 60000 });
  const ids = (devFleet.json?.projects || []).map((p) => p.projectId);
  expect(devFleet.status === 200 && ids.includes(a) && !ids.includes(b), 'fleet shows a member only their projects', `HTTP ${devFleet.status}`);
}

await main(async () => {
  if (mode === 'scoping') await scoping();
  else throw new Error('usage: observability.mjs scoping');
});
