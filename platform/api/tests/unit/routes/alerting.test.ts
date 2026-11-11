/**
 * Alerting routes (#43): permissions (project members read, developers ack, project devops/owners
 * and platform admin/devops configure; raw-query monitors and ratio SLOs platform-only, #151), audit, write-only channel secrets, SSRF on create, Alertmanager webhook auth,
 * and the legacy /alerts mirror.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { MemoryRepo } from '../../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../../src/config/database', () => ({
  getDb: async () => ({ getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name) }),
}));
const mockAudit = jest.fn(async (_p: any) => {});
jest.mock('../../../src/middleware/auth', () => ({
  expressAuthenticate: (req: any, res: any, next: any) => {
    if (!req.get('x-user')) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: req.get('x-user'), role: req.get('x-role') || 'developer' };
    req.humanJwt = true;
    next();
  },
  expressRequireRole: (roles: string[]) => (req: any, res: any, next: any) =>
    req.user.role === 'admin' || roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden: Insufficient permissions' }),
  logAudit: (p: any) => mockAudit(p),
}));
jest.mock('../../../src/lib/notify', () => ({ notifyUser: jest.fn(async () => {}) }));
jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: async (host: string) => [{ address: host.startsWith('internal') ? '10.0.0.7' : '93.184.215.14', family: 4 }],
    },
  };
});

import alerting from '../../../src/routes/alerting';
import alerts from '../../../src/routes/alerts';
import { alertmanagerWebhookToken } from '../../../src/lib/alerting-k8s';

process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-alerting-routes';

const PID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VIEWER = '33333333-0000-4000-8000-000000000001';
const DEV = '33333333-0000-4000-8000-000000000002';
const PROJ_DEVOPS = '33333333-0000-4000-8000-000000000003';
const OPS = '33333333-0000-4000-8000-000000000004';
const ADMIN = '33333333-0000-4000-8000-000000000005';
const OWNER = '33333333-0000-4000-8000-000000000006';
const OUTSIDER = '33333333-0000-4000-8000-000000000007';

function app() {
  const a = express();
  a.use(express.json());
  a.use(alerting);
  a.use(alerts);
  return a;
}
const as = (r: request.Test, user: string, role = 'developer') => r.set('x-user', user).set('x-role', role);
const ops = (r: request.Test) => as(r, OPS, 'devops');

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  mockAudit.mockClear();
  mockRepo('Project').rows.push({ id: PID, name: 'shop' }, { id: OTHER, name: 'other' });
  mockRepo('ProjectMember').rows.push(
    { id: 'm1', projectId: PID, userId: VIEWER, role: 'viewer' },
    { id: 'm2', projectId: PID, userId: DEV, role: 'developer' },
    { id: 'm3', projectId: PID, userId: PROJ_DEVOPS, role: 'devops' },
    { id: 'm4', projectId: PID, userId: OWNER, role: 'owner' },
  );
  mockRepo('User').rows.push({ id: OPS, role: 'devops' }, { id: DEV, role: 'developer' }, { id: OUTSIDER, role: 'developer' });
});

const base = `/projects/${PID}/alerting`;

describe('permissions', () => {
  it('requires authentication', async () => {
    expect((await request(app()).get(`${base}/incidents`)).status).toBe(401);
  });

  it('project members read; non-members do not', async () => {
    expect((await as(request(app()).get(`${base}/incidents`), VIEWER)).status).toBe(200);
    expect((await as(request(app()).get(`${base}/monitors`), VIEWER)).status).toBe(200);
    expect((await as(request(app()).get(`/projects/${OTHER}/alerting/incidents`), VIEWER)).status).toBe(403);
    expect((await as(request(app()).get(`/projects/not-a-uuid/alerting/incidents`), VIEWER)).status).toBe(400);
  });

  it('raw-query (metric/log) monitors need platform admin/devops: project devops/owners and developers get 403', async () => {
    const body = { name: 'm', kind: 'metric', query: 'up', operator: '<', threshold: 1 };
    const denied = await as(request(app()).post(`${base}/monitors`).send(body), PROJ_DEVOPS, 'developer');
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/platform admins and devops.*not limited to this project/);
    expect((await as(request(app()).post(`${base}/monitors`).send({ ...body, kind: 'log', query: '{a="b"}' }), OWNER)).status).toBe(403);
    expect((await as(request(app()).post(`${base}/silences`).send({ durationMinutes: 10 }), DEV)).status).toBe(403);
    const res = await ops(request(app()).post(`${base}/monitors`).send(body));
    expect(res.status).toBe(201);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'alerting.monitor.create', userId: OPS, targetId: res.body.id }));
    expect((await as(request(app()).post(`${base}/monitors`).send(body), ADMIN, 'admin')).status).toBe(201);
    // Existing raw monitors cannot be edited by project devops either (even just disabling).
    expect((await as(request(app()).put(`${base}/monitors/${res.body.id}`).send({ enabled: false }), PROJ_DEVOPS)).status).toBe(403);
    expect(mockRepo('AlertMonitor').rows.find((r: any) => r.id === res.body.id).enabled).toBe(true);
  });

  it('project devops/owners configure their project: channels, policies, schedules, silences, SLOs, scoped monitors (#151)', async () => {
    const pd = (r: request.Test) => as(r, PROJ_DEVOPS);
    const ch = await pd(request(app()).post(`${base}/channels`).send({ name: 'd', type: 'discord', secrets: { webhookUrl: 'https://discord.example.test/api/webhooks/1/x' } }));
    expect(ch.status).toBe(201);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'alerting.channel.create', userId: PROJ_DEVOPS }));
    const pol = await pd(request(app()).post(`${base}/policies`).send({ name: 'p', steps: [{ channelIds: [ch.body.id] }] }));
    expect(pol.status).toBe(201);
    expect((await pd(request(app()).post(`${base}/schedules`).send({ name: 's', userIds: [DEV], rotationHours: 24, startsAt: new Date().toISOString() }))).status).toBe(201);
    expect((await pd(request(app()).post(`${base}/silences`).send({ durationMinutes: 10 }))).status).toBe(201);
    expect((await pd(request(app()).post(`${base}/slos`).send({ name: 'a', sliType: 'availability', target: 99 }))).status).toBe(201);
    const mon = await pd(request(app()).post(`${base}/monitors`).send({ name: 'cpu', kind: 'resource', params: { resource: 'cpu' }, threshold: 80, policyId: pol.body.id }));
    expect(mon.status).toBe(201);
    expect((await pd(request(app()).post(`${base}/monitors`).send({ name: 'err', kind: 'trace', params: { signal: 'error_rate' }, threshold: 5 }))).status).toBe(201);
    expect((await pd(request(app()).put(`${base}/monitors/${mon.body.id}`).send({ threshold: 90 }))).body.threshold).toBe(90);
    expect((await as(request(app()).post(`${base}/test-event`).send({ key: 'k' }), OWNER)).status).toBe(202);
    expect((await as(request(app()).post(`${base}/monitors`).send({ name: 'mem', kind: 'resource', params: { resource: 'memory' }, threshold: 80 }), OWNER)).status).toBe(201);
    // Not on other projects.
    expect((await pd(request(app()).post(`/projects/${OTHER}/alerting/silences`).send({ durationMinutes: 10 }))).status).toBe(403);
  });

  it('project developers cannot configure alerting', async () => {
    const d = (r: request.Test) => as(r, DEV);
    expect((await d(request(app()).post(`${base}/channels`).send({ name: 'd', type: 'discord', secrets: { webhookUrl: 'https://discord.example.test/api/webhooks/1/x' } }))).status).toBe(403);
    expect((await d(request(app()).post(`${base}/policies`).send({ name: 'p', steps: [] }))).status).toBe(403);
    expect((await d(request(app()).post(`${base}/monitors`).send({ name: 'cpu', kind: 'resource', params: { resource: 'cpu' }, threshold: 80 }))).status).toBe(403);
    expect((await d(request(app()).post(`${base}/slos`).send({ name: 'a', sliType: 'availability', target: 99 }))).status).toBe(403);
  });

  it('project devops cannot turn a scoped monitor into a raw-query one; platform devops can (#151)', async () => {
    const mon = await as(request(app()).post(`${base}/monitors`).send({ name: 'cpu', kind: 'resource', params: { resource: 'cpu' }, threshold: 80 }), PROJ_DEVOPS);
    expect(mon.status).toBe(201);
    const r = await as(request(app()).put(`${base}/monitors/${mon.body.id}`).send({ kind: 'metric', query: 'up' }), PROJ_DEVOPS);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/metric monitors/);
    expect(mockRepo('AlertMonitor').rows.find((x: any) => x.id === mon.body.id)).toMatchObject({ kind: 'resource', query: null });
    expect((await as(request(app()).put(`${base}/monitors/${mon.body.id}`).send({ kind: 'log', query: '{a="b"}' }), OWNER)).status).toBe(403);
    const ok = await ops(request(app()).put(`${base}/monitors/${mon.body.id}`).send({ kind: 'metric', query: 'up' }));
    expect(ok.status).toBe(200);
    expect(ok.body.kind).toBe('metric');
  });

  it('ratio SLOs (raw PromQL) are platform admin/devops only (#151)', async () => {
    const body = { name: 'r', sliType: 'ratio', errorQuery: 'sum(rate(x_errors[$window]))', totalQuery: 'sum(rate(x_total[$window]))', target: 99 };
    expect((await as(request(app()).post(`${base}/slos`).send(body), PROJ_DEVOPS)).status).toBe(403);
    const slo = await as(request(app()).post(`${base}/slos`).send({ name: 'a', sliType: 'availability', target: 99 }), PROJ_DEVOPS);
    expect((await as(request(app()).put(`${base}/slos/${slo.body.id}`).send({ sliType: 'ratio', errorQuery: body.errorQuery, totalQuery: body.totalQuery }), PROJ_DEVOPS)).status).toBe(403);
    expect((await ops(request(app()).post(`${base}/slos`).send(body))).status).toBe(201);
  });

  it('project devops page only people who can see the project; platform devops page anyone', async () => {
    const sched = (user: string, role: string, ids: string[]) => as(request(app()).post(`${base}/schedules`).send({ name: 's', userIds: ids, rotationHours: 24, startsAt: new Date().toISOString() }), user, role);
    const r = await sched(PROJ_DEVOPS, 'developer', [DEV, OUTSIDER]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a member/);
    expect((await sched(PROJ_DEVOPS, 'developer', [DEV, OPS])).status).toBe(201);
    expect((await as(request(app()).post(`${base}/policies`).send({ name: 'p', steps: [{ userIds: [OUTSIDER] }] }), PROJ_DEVOPS)).status).toBe(400);
    expect((await sched(OPS, 'devops', [OUTSIDER])).status).toBe(201);
  });

  it('project devops still cannot set allowPrivateNetwork on channels', async () => {
    const priv = { name: 'h', type: 'webhook', secrets: { url: 'https://internal.example.test/hook' }, allowPrivateNetwork: true };
    expect((await as(request(app()).post(`${base}/channels`).send(priv), PROJ_DEVOPS)).status).toBe(403);
  });

  it('developers acknowledge / resolve incidents of their project; viewers cannot', async () => {
    mockRepo('AlertIncident').rows.push({ id: '44444444-0000-4000-8000-000000000001', projectId: PID, dedupeKey: 'monitor:x', status: 'firing', severity: 'warning', title: 't', timeline: [], firstSeenAt: new Date(), lastSeenAt: new Date(), notifiedAt: null, escalationStep: 0 });
    const id = '44444444-0000-4000-8000-000000000001';
    expect((await as(request(app()).post(`${base}/incidents/${id}/ack`), VIEWER)).status).toBe(403);
    const ack = await as(request(app()).post(`${base}/incidents/${id}/ack`), DEV);
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ status: 'acknowledged', acknowledgedBy: DEV });
    expect((await as(request(app()).post(`${base}/incidents/${id}/resolve`), DEV)).body.status).toBe('resolved');
    expect((await as(request(app()).post(`/projects/${OTHER}/alerting/incidents/${id}/ack`), DEV)).status).toBe(403);
  });
});

describe('channels', () => {
  it('test notification names the project (not its id)', async () => {
    const channels = jest.requireActual('../../../src/lib/alerting-channels');
    const spy = jest.spyOn(channels, 'sendToChannel').mockResolvedValue(undefined);
    try {
      const res = await ops(request(app()).post(`${base}/channels`).send({ name: 'hook', type: 'webhook', secrets: { url: 'https://receiver.example.test/x' } }));
      const t = await ops(request(app()).post(`${base}/channels/${res.body.id}/test`));
      expect(t.status).toBe(200);
      expect(spy.mock.calls[0][1]).toMatchObject({ event: 'test', projectId: PID, projectName: 'shop' });
    } finally {
      spy.mockRestore();
    }
  });

  it('secrets are write-only; the generated signing secret is returned once', async () => {
    const res = await ops(request(app()).post(`${base}/channels`).send({ name: 'hook', type: 'webhook', secrets: { url: 'https://receiver.example.test/SECRETPATH' } }));
    expect(res.status).toBe(201);
    expect(res.body.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(res.body)).not.toContain('SECRETPATH');
    expect(res.body).toMatchObject({ destination: 'receiver.example.test', secretFields: ['signingSecret', 'url'] });
    const list = await as(request(app()).get(`${base}/channels`), VIEWER);
    expect(JSON.stringify(list.body)).not.toContain('SECRETPATH');
    expect(JSON.stringify(list.body)).not.toContain(res.body.signingSecret);
    expect(list.body[0]).not.toHaveProperty('secretEnc');
    expect(JSON.stringify(mockAudit.mock.calls)).not.toContain('SECRETPATH');
    expect(mockRepo('AlertChannel').rows[0].secretEnc).not.toContain('SECRETPATH');

    // Update without secrets keeps them; rename only.
    const upd = await ops(request(app()).put(`${base}/channels/${res.body.id}`).send({ name: 'renamed' }));
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: 'renamed', secretFields: ['signingSecret', 'url'] });
    expect(upd.body.signingSecret).toBeUndefined();
  });

  it('refuses private destinations; only admins may allow private networks', async () => {
    const priv = { name: 'h', type: 'webhook', secrets: { url: 'https://internal.example.test/hook' } };
    const r1 = await ops(request(app()).post(`${base}/channels`).send(priv));
    expect(r1.status).toBe(400);
    expect(r1.body.error).toMatch(/private/);
    expect((await ops(request(app()).post(`${base}/channels`).send({ ...priv, allowPrivateNetwork: true }))).status).toBe(403);
    expect((await as(request(app()).post(`${base}/channels`).send({ ...priv, allowPrivateNetwork: true }), ADMIN, 'admin')).status).toBe(201);
    expect((await ops(request(app()).post(`${base}/channels`).send({ name: 'x', type: 'sms' }))).status).toBe(400);
  });
});

describe('monitors, SLOs, silences, policies, schedules', () => {
  it('validates monitors and policies belong to the project', async () => {
    expect((await ops(request(app()).post(`${base}/monitors`).send({ name: 'm', kind: 'trace', params: { signal: 'nope' }, threshold: 1 }))).status).toBe(400);
    expect((await ops(request(app()).post(`${base}/monitors`).send({ name: 'm', kind: 'metric', query: 'up', threshold: 'x' }))).status).toBe(400);
    mockRepo('AlertEscalationPolicy').rows.push({ id: '55555555-0000-4000-8000-000000000001', projectId: OTHER, steps: [] });
    const r = await ops(request(app()).post(`${base}/monitors`).send({ name: 'm', kind: 'resource', params: { resource: 'cpu' }, threshold: 80, policyId: '55555555-0000-4000-8000-000000000001' }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/policyId/);
  });

  it('creates an SLO and returns its status', async () => {
    const r = await ops(request(app()).post(`${base}/slos`).send({ name: 'Availability', sliType: 'availability', params: { service: 'web' }, target: 99.5, windowDays: 28 }));
    expect(r.status).toBe(201);
    const st = await as(request(app()).get(`${base}/slos/${r.body.id}/status`), VIEWER);
    expect(st.body).toMatchObject({ id: r.body.id, target: 99.5, windowDays: 28, status: null });
    expect((await ops(request(app()).post(`${base}/slos`).send({ name: 'x', sliType: 'availability', target: 120 }))).status).toBe(400);
  });

  it('silences: create with matchers + duration, list state, expire', async () => {
    const r = await ops(request(app()).post(`${base}/silences`).send({ matchers: [{ name: 'source', value: 'synthetics' }], durationMinutes: 60, comment: 'maintenance' }));
    expect(r.status).toBe(201);
    let list = await as(request(app()).get(`${base}/silences`), VIEWER);
    expect(list.body[0]).toMatchObject({ state: 'active', comment: 'maintenance' });
    expect((await ops(request(app()).delete(`${base}/silences/${r.body.id}`))).status).toBe(200);
    list = await as(request(app()).get(`${base}/silences`), VIEWER);
    expect(list.body[0].state).toBe('expired');
    expect((await ops(request(app()).post(`${base}/silences`).send({ endsAt: '2000-01-01T00:00:00Z' }))).status).toBe(400);
  });

  it('policies reference only own channels; schedules report who is on call', async () => {
    const ch = await ops(request(app()).post(`${base}/channels`).send({ name: 'd', type: 'discord', secrets: { webhookUrl: 'https://discord.example.test/api/webhooks/1/x' } }));
    const bad = await ops(request(app()).post(`${base}/policies`).send({ name: 'p', steps: [{ channelIds: ['66666666-0000-4000-8000-000000000001'] }] }));
    expect(bad.status).toBe(400);
    const sch = await ops(request(app()).post(`${base}/schedules`).send({ name: 'primary', userIds: [OPS, DEV], rotationHours: 24, startsAt: new Date().toISOString() }));
    expect(sch.status).toBe(201);
    expect(sch.body.onCallUserId).toBe(OPS);
    const pol = await ops(request(app()).post(`${base}/policies`).send({ name: 'p', isDefault: true, steps: [{ channelIds: [ch.body.id] }, { delayMinutes: 10, scheduleIds: [sch.body.id] }] }));
    expect(pol.status).toBe(201);
    expect(pol.body.steps[1]).toMatchObject({ delayMinutes: 10, scheduleIds: [sch.body.id] });
  });

  it('test event runs through the pipeline', async () => {
    const r = await ops(request(app()).post(`${base}/test-event`).send({ key: 'k1' }));
    expect(r.status).toBe(202);
    const list = await as(request(app()).get(`${base}/incidents`), VIEWER);
    expect(list.body.map((i: any) => i.dedupeKey)).toEqual(['test:k1']);
  });
});

describe('Alertmanager webhook', () => {
  const MON = '77777777-0000-4000-8000-000000000001';
  const payload = (status: string, project = PID) => ({
    version: '4', status,
    alerts: [{ status, labels: { alertname: 'PlatformMonitor_x', project, platform_source: 'monitor', platform_monitor_id: MON, severity: 'critical', namespace: 'monitoring' }, annotations: { summary: 'CPU high' }, startsAt: new Date().toISOString() }],
  });

  it('requires the bearer token', async () => {
    expect((await request(app()).post('/alerting/alertmanager/webhook').send(payload('firing'))).status).toBe(401);
    expect((await request(app()).post('/alerting/alertmanager/webhook').set('Authorization', 'Bearer wrong').send(payload('firing'))).status).toBe(401);
  });

  it('turns alerts of generated rules into incidents; ignores foreign/unknown rules', async () => {
    mockRepo('AlertMonitor').rows.push({ id: MON, projectId: PID, name: 'CPU', policyId: null });
    const auth = `Bearer ${alertmanagerWebhookToken()}`;
    let r = await request(app()).post('/alerting/alertmanager/webhook').set('Authorization', auth).send(payload('firing', OTHER));
    expect(r.body.accepted).toBe(0);
    r = await request(app()).post('/alerting/alertmanager/webhook').set('Authorization', auth).send(payload('firing'));
    expect(r.body.accepted).toBe(1);
    expect(mockRepo('AlertIncident').rows[0]).toMatchObject({ dedupeKey: `monitor:${MON}`, status: 'firing', title: 'CPU high', severity: 'critical' });
    await request(app()).post('/alerting/alertmanager/webhook').set('Authorization', auth).send(payload('resolved'));
    expect(mockRepo('AlertIncident').rows[0].status).toBe('resolved');
  });
});

describe('legacy /alerts', () => {
  it('POST /alerts still works and is mirrored to a monitor', async () => {
    const r = await as(request(app()).post('/alerts').send({ projectId: PID, type: 'cpu_high', config: { metric: 'cpu', operator: '>', threshold: 90 } }), OPS, 'devops');
    expect(r.status).toBe(201);
    expect(mockRepo('AlertMonitor').rows[0]).toMatchObject({ projectId: PID, kind: 'resource', params: { resource: 'cpu' }, threshold: 90, legacyAlertId: r.body.id });
  });

  it('POST /alerts/evaluate answers as before but is marked deprecated', async () => {
    mockRepo('Alert').rows.push({ id: 'a1', projectId: PID, isEnabled: true, severity: 'warning', config: { metric: 'cpu', operator: '>', threshold: 50 } });
    const r = await as(request(app()).post('/alerts/evaluate').send({ projectId: PID, metrics: { cpu: 70 } }), OPS, 'devops');
    expect(r.status).toBe(200);
    expect(r.headers.deprecation).toBe('true');
    expect(r.body).toMatchObject({ evaluatedCount: 1, triggered: [{ ruleId: 'a1', value: 70 }] });
  });
});
