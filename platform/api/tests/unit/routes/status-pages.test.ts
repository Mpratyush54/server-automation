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
  events.length = 0;
  mockPages.rows.length = 0;
  mockIncidents.rows.length = 0;
  mockAudit.rows.length = 0;
  mockProjects.rows.length = 0;
  mockProjects.rows.push({ id: PROJ, name: 'Acme App' });
});

describe('admin status page', () => {
  it('creates a draft page on first GET and forbids outsiders', async () => {
    const ok = await request(app).get(`/api/projects/${PROJ}/status-page`).set(as('uid-view'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ projectId: PROJ, published: false, slug: 'acme-app', publicPath: '/status/acme-app' });

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
