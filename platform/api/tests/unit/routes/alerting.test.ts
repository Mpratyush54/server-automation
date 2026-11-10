/**
 * Alerting routes (#43): permissions (project members read, developers ack, admin/devops
 * configure), audit, write-only channel secrets, SSRF on create, Alertmanager webhook auth,
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
  );
  mockRepo('User').rows.push({ id: OPS, role: 'devops' }, { id: DEV, role: 'developer' });
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

  it('configuration needs platform admin/devops: project devops members and developers get 403', async () => {
    const body = { name: 'm', kind: 'metric', query: 'up', operator: '<', threshold: 1 };
    expect((await as(request(app()).post(`${base}/monitors`).send(body), PROJ_DEVOPS, 'developer')).status).toBe(403);
    expect((await as(request(app()).post(`${base}/silences`).send({ durationMinutes: 10 }), DEV)).status).toBe(403);
    const res = await ops(request(app()).post(`${base}/monitors`).send(body));
    expect(res.status).toBe(201);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'alerting.monitor.create', userId: OPS, targetId: res.body.id }));
    expect((await as(request(app()).post(`${base}/monitors`).send(body), ADMIN, 'admin')).status).toBe(201);
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
