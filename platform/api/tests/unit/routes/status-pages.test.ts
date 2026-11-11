/**
 * #46 — status page admin + public routes: auth gating, publish toggle,
 * public serializer contract, and cache headers.
 */
import { MemoryRepo } from '../../helpers/memory-repo';

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mockUsers: Record<string, any> = {
  'uid-admin': { id: 'uid-admin', role: 'admin', roleId: null, name: 'Admin', email: 'a@io', isActive: true },
  'uid-dev': { id: 'uid-dev', role: 'developer', roleId: null, name: 'Dev', email: 'dev@io', isActive: true },
  'uid-view': { id: 'uid-view', role: 'developer', roleId: null, name: 'View', email: 'v@io', isActive: true },
  'uid-out': { id: 'uid-out', role: 'tech_lead', roleId: null, name: 'Out', email: 'out@io', isActive: true },
};
const mockMembers = [
  { projectId: PROJ, userId: 'uid-dev', role: 'devops' },
  { projectId: PROJ, userId: 'uid-view', role: 'viewer' },
];

const mockPages = new MemoryRepo<any>(() => ({ createdAt: new Date(), updatedAt: new Date(), branding: {} }));
const mockIncidents = new MemoryRepo<any>(() => ({ createdAt: new Date(), updatedAt: new Date(), updates: [] }));
const mockAudit = new MemoryRepo<any>();
const mockProjects = new MemoryRepo<any>();

const mockRepos: Record<string, any> = {
  User: { findOne: jest.fn(async ({ where }: any) => mockUsers[where.id] || null) },
  ProjectMember: {
    findOne: jest.fn(async ({ where }: any) => mockMembers.find((m) => m.projectId === where.projectId && m.userId === where.userId) || null),
  },
  Project: mockProjects,
  StatusPage: mockPages,
  StatusIncident: mockIncidents,
  AuditLog: mockAudit,
  Role: { findOne: jest.fn(async () => null) },
  SyntheticCheck: { find: jest.fn(async () => []) },
};
const mockGetRepository = (e: any) => mockRepos[typeof e === 'string' ? e : e.name];

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: mockGetRepository,
    query: jest.fn(async () => []),
  })),
}));

jest.mock('../../../src/lib/synthetic-status', () => {
  const actual = jest.requireActual('../../../src/lib/synthetic-status');
  return {
    ...actual,
    getProjectStatusFeed: jest.fn(async (projectId: string) => ({
      projectId,
      generatedAt: '2026-11-10T12:00:00.000Z',
      status: 'operational',
      components: [{
        id: 'c1',
        name: 'API',
        type: 'http',
        status: 'operational',
        lastCheckedAt: '2026-11-10T11:59:00.000Z',
        uptime: { '24h': 100, '7d': 99.9, '30d': 99.5 },
        avgLatencyMs24h: 42,
        days: [{ date: '2026-11-10', uptime: 100, status: 'operational' }],
      }],
    })),
  };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import statusPageRouter from '../../../src/routes/status-pages';
import { clearPermissionCache } from '../../../src/middleware/auth';
import { setAlertEventTestHook, AlertEvent } from '../../../src/lib/alert-events';
import { clearMemoryPublicCache } from '../../../src/lib/status-page';

const JWT_SECRET = 'status-page-test-jwt-secret-0123456789';
const as = (id: string) => ({ Authorization: `Bearer ${jwt.sign({ id, amr: ['pwd'] }, JWT_SECRET, { expiresIn: '1h' })}` });
const events: AlertEvent[] = [];

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  app = express();
  app.use(express.json());
  app.use('/api', statusPageRouter);
  setAlertEventTestHook((e) => events.push(e));
});
afterAll(() => setAlertEventTestHook(null));

beforeEach(() => {
  clearPermissionCache();
  clearMemoryPublicCache();
  events.length = 0;
  mockPages.rows.length = 0;
  mockIncidents.rows.length = 0;
  mockAudit.rows.length = 0;
  mockProjects.rows.length = 0;
  mockProjects.rows.push({ id: PROJ, name: 'Acme App' });
});

describe('admin status page', () => {
  it('returns draft defaults on GET without persisting, and forbids outsiders', async () => {
    const ok = await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-view'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: null, projectId: PROJ, published: false, slug: 'acme-app', publicPath: '/status/acme-app' });
    expect(mockPages.rows).toHaveLength(0);

    const denied = await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-out'));
    expect(denied.status).toBe(403);
  });

  it('publishes settings (devops+) and serves the public JSON without auth', async () => {
    await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-dev'));
    const put = await request(app)
      .put(`/api/projects/${PROJ}/status-page`)
      .set(as('uid-dev'))
      .send({
        slug: 'acme',
        published: true,
        title: 'Acme Status',
        branding: { primaryColor: '#102030' },
      });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ slug: 'acme', published: true, title: 'Acme Status' });

    const viewerPut = await request(app)
      .put(`/api/projects/${PROJ}/status-page`)
      .set(as('uid-view'))
      .send({ published: false });
    expect(viewerPut.status).toBe(403);

    const pub = await request(app).get('/api/public/status/acme');
    expect(pub.status).toBe(200);
    expect(pub.headers['cache-control']).toMatch(/public/);
    expect(pub.body).toMatchObject({
      slug: 'acme',
      title: 'Acme Status',
      status: 'operational',
      components: [{ name: 'API', status: 'operational' }],
    });
    expect(pub.body.projectId).toBeUndefined();
    const text = JSON.stringify(pub.body);
    expect(text).not.toContain(PROJ);

    const missing = await request(app).get('/api/public/status/nope');
    expect(missing.status).toBe(404);
  });

  it('creates the page on the first save', async () => {
    const put = await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev')).send({ title: 'Mine' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ slug: 'acme-app', title: 'Mine', published: false });
    expect(put.body.id).toEqual(expect.any(String));
    expect(mockPages.rows).toHaveLength(1);
    const again = await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-view'));
    expect(again.body.id).toBe(put.body.id);
  });

  it('rejects a domain already used by another status page and keeps it out of the public JSON', async () => {
    mockPages.rows.push({
      id: 'other-page', projectId: OTHER, slug: 'other', title: 'Other', domain: 'status.acme.example',
      published: true, branding: {}, componentIds: null, createdAt: new Date(), updatedAt: new Date(),
    });
    const clash = await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev'))
      .send({ domain: 'Status.Acme.Example' });
    expect(clash.status).toBe(409);

    const ok = await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev'))
      .send({ slug: 'acme', published: true, domain: 'status.mine.example' });
    expect(ok.status).toBe(200);
    expect(ok.body.domain).toBe('status.mine.example');
    // saving the same domain again is not a conflict with itself
    const same = await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev'))
      .send({ domain: 'status.mine.example' });
    expect(same.status).toBe(200);

    const pub = await request(app).get('/api/public/status/acme');
    expect(pub.status).toBe(200);
    expect(pub.body.domain).toBeUndefined();
    expect(JSON.stringify(pub.body)).not.toContain('status.mine.example');
  });

  it('hides unpublished pages from the public endpoint', async () => {
    await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-dev'));
    await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev')).send({ slug: 'hidden', published: false });
    const pub = await request(app).get('/api/public/status/hidden');
    expect(pub.status).toBe(404);
  });
});

describe('incidents', () => {
  beforeEach(async () => {
    await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-dev'));
    await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev')).send({ slug: 'acme', published: true });
  });

  it('creates incidents, serves them publicly, and emits status-page alerts for major impact', async () => {
    const created = await request(app)
      .post(`/api/projects/${PROJ}/status-page/incidents`)
      .set(as('uid-dev'))
      .send({ title: 'API degraded', impact: 'major', body: 'Investigating latency' });
    expect(created.status).toBe(201);
    expect(created.body.incident).toMatchObject({ title: 'API degraded', status: 'investigating' });
    expect(created.body.incident.updates[0].by).toBeUndefined();
    expect(events.some((e) => e.source === 'status-page' && e.dedupeKey.startsWith('status-incident:'))).toBe(true);

    const pub = await request(app).get('/api/public/status/acme');
    expect(pub.body.incidents).toHaveLength(1);
    expect(JSON.stringify(pub.body)).not.toContain('uid-dev');

    const atom = await request(app).get('/api/public/status/acme/atom');
    expect(atom.status).toBe(200);
    expect(atom.text).toContain('API degraded');

    const id = created.body.incident.id;
    const updated = await request(app)
      .post(`/api/projects/${PROJ}/status-page/incidents/${id}/updates`)
      .set(as('uid-dev'))
      .send({ status: 'resolved', body: 'Mitigated' });
    expect(updated.status).toBe(200);
    expect(updated.body.incident.status).toBe('resolved');
    const resolvedEvents = events.filter((e) => e.status === 'resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0].dedupeKey).toBe(`status-incident:${id}`);
  });

  it('does not emit resolved for incidents that never fired (minor, maintenance)', async () => {
    for (const body of [
      { title: 'Minor blip', impact: 'minor' },
      { title: 'DB upgrade', impact: 'major', isMaintenance: true },
    ]) {
      const created = await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev')).send(body);
      expect(created.status).toBe(201);
      const res = await request(app)
        .post(`/api/projects/${PROJ}/status-page/incidents/${created.body.incident.id}/updates`)
        .set(as('uid-dev'))
        .send({ status: 'resolved', body: 'Done' });
      expect(res.status).toBe(200);
    }
    expect(events).toHaveLength(0);
  });

  it('does not emit resolved for a major incident created while the page was unpublished', async () => {
    await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev')).send({ published: false });
    const created = await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev'))
      .send({ title: 'Quiet outage', impact: 'critical' });
    await request(app).put(`/api/projects/${PROJ}/status-page`).set(as('uid-dev')).send({ published: true });
    await request(app)
      .post(`/api/projects/${PROJ}/status-page/incidents/${created.body.incident.id}/updates`)
      .set(as('uid-dev'))
      .send({ status: 'resolved', body: 'Done' });
    expect(events).toHaveLength(0);
  });

  it('resolves the alert when a firing incident is deleted', async () => {
    const created = await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev'))
      .send({ title: 'Outage', impact: 'critical' });
    const id = created.body.incident.id;
    const del = await request(app).delete(`/api/projects/${PROJ}/status-page/incidents/${id}`).set(as('uid-dev'));
    expect(del.status).toBe(204);
    expect(events.map((e) => e.status)).toEqual(['firing', 'resolved']);
  });

  it('audits incident updates, resolves and deletes', async () => {
    const created = await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev'))
      .send({ title: 'Slow', impact: 'minor' });
    const id = created.body.incident.id;
    const base = `/api/projects/${PROJ}/status-page/incidents/${id}`;
    await request(app).post(`${base}/updates`).set(as('uid-dev')).send({ status: 'identified', body: 'Found it' });
    await request(app).post(`${base}/updates`).set(as('uid-dev')).send({ status: 'resolved', body: 'Fixed' });
    await request(app).delete(base).set(as('uid-dev'));
    const actions = mockAudit.rows.map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining([
      'status_page.incident.created',
      'status_page.incident.updated',
      'status_page.incident.resolved',
      'status_page.incident.deleted',
    ]));
    const del = mockAudit.rows.find((r: any) => r.action === 'status_page.incident.deleted');
    expect(del).toMatchObject({ targetType: 'StatusIncident', targetId: id, userId: 'uid-dev' });
  });

  it('shows future maintenance as upcoming with its window, not as active', async () => {
    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date(Date.now() + 7200_000).toISOString();
    const created = await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev'))
      .send({ title: 'DB upgrade', impact: 'minor', isMaintenance: true, scheduledStart: start, scheduledEnd: end });
    expect(created.status).toBe(201);
    expect(created.body.incident).toMatchObject({ status: 'scheduled', phase: 'upcoming', scheduledStart: start, scheduledEnd: end });

    const pub = await request(app).get('/api/public/status/acme');
    expect(pub.body.incidents[0]).toMatchObject({ phase: 'upcoming', scheduledStart: start, scheduledEnd: end });
  });

  it('reports maintenance past its window as resolved publicly; RSS links to the HTML page', async () => {
    const start = new Date(Date.now() - 7200_000).toISOString();
    const end = new Date(Date.now() - 3600_000).toISOString();
    await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev'))
      .send({ title: 'Old window', impact: 'minor', isMaintenance: true, scheduledStart: start, scheduledEnd: end });
    const pub = await request(app).get('/api/public/status/acme');
    expect(pub.body.incidents[0]).toMatchObject({ status: 'resolved', phase: 'resolved', resolvedAt: end });
    const rss = await request(app).get('/api/public/status/acme/rss');
    expect(rss.text).toMatch(/<link>http:\/\/127\.0\.0\.1:\d+\/status\/acme<\/link>/);
  });

  it('caches the public feed in-process and invalidates on incident changes', async () => {
    const first = await request(app).get('/api/public/status/acme');
    expect(first.body.incidents).toHaveLength(0);
    // A write that bypasses the API is not visible until the TTL lapses...
    mockIncidents.rows.push({
      id: 'direct', statusPageId: mockPages.rows[0].id, projectId: PROJ, title: 'Direct', status: 'investigating',
      impact: 'minor', isMaintenance: false, updates: [], createdAt: new Date(), updatedAt: new Date(),
    });
    expect((await request(app).get('/api/public/status/acme')).body.incidents).toHaveLength(0);
    // ...but an API change invalidates immediately.
    await request(app).post(`/api/projects/${PROJ}/status-page/incidents`).set(as('uid-dev')).send({ title: 'Via API' });
    expect((await request(app).get('/api/public/status/acme')).body.incidents).toHaveLength(2);
  });

  it('rejects cross-project incident access', async () => {
    const created = await request(app)
      .post(`/api/projects/${PROJ}/status-page/incidents`)
      .set(as('uid-dev'))
      .send({ title: 'x', impact: 'minor' });
    const id = created.body.incident.id;
    const cross = await request(app)
      .post(`/api/projects/${OTHER}/status-page/incidents/${id}/updates`)
      .set(as('uid-dev'))
      .send({ status: 'resolved', body: 'nope' });
    expect([403, 404]).toContain(cross.status);
  });
});
