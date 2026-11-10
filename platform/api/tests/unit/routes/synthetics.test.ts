/**
 * #42 — synthetic checks API: project-member permissions, audit entries, write-only
 * secrets, SSRF refusal on save, run-now, results/status feed, and the browser runner
 * endpoints (per-check token, screenshot stored on failure).
 */
import { Readable } from 'stream';
import { MemoryRepo } from '../../helpers/memory-repo';

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENV = 'eeeeeeee-0000-4000-8000-000000000001';
const MASTER_KEY = 'd'.repeat(64);

const mockUsers: Record<string, any> = {
  'uid-admin': { id: 'uid-admin', role: 'admin', roleId: null, name: 'Admin', email: 'a@io', isActive: true },
  'uid-dev': { id: 'uid-dev', role: 'developer', roleId: null, name: 'Dev', email: 'dev@io', isActive: true },
  'uid-view': { id: 'uid-view', role: 'developer', roleId: null, name: 'View', email: 'v@io', isActive: true },
  'uid-out': { id: 'uid-out', role: 'tech_lead', roleId: null, name: 'Out', email: 'out@io', isActive: true },
};
const mockMembers = [
  { projectId: PROJ, userId: 'uid-dev', role: 'developer' },
  { projectId: PROJ, userId: 'uid-view', role: 'viewer' },
];
const mockChecks = new MemoryRepo<any>(() => ({ createdAt: new Date(), updatedAt: new Date() }));
const mockResults = new MemoryRepo<any>(() => ({ createdAt: new Date() }));
const mockAudit = new MemoryRepo<any>();

function resultsQb() {
  const state: any = { where: [] as Array<(r: any) => boolean>, take: 100 };
  const qb: any = {
    where: (_s: string, p: any) => { state.where.push((r: any) => r.checkId === p.id); return qb; },
    andWhere: (_s: string, p: any) => { state.where.push((r: any) => r.startedAt < p.before); return qb; },
    orderBy: () => qb,
    take: (n: number) => { state.take = n; return qb; },
    getMany: async () => mockResults.rows.filter((r) => state.where.every((f: any) => f(r)))
      .sort((a, b) => b.startedAt - a.startedAt).slice(0, state.take).map((r) => ({ ...r })),
  };
  return qb;
}

const mockRepos: Record<string, any> = {
  User: { findOne: jest.fn(async ({ where }: any) => mockUsers[where.id] || null) },
  ProjectMember: {
    findOne: jest.fn(async ({ where }: any) => mockMembers.find((m) => m.projectId === where.projectId && m.userId === where.userId) || null),
  },
  Environment: {
    find: jest.fn(async ({ where }: any) => (where.projectId === PROJ ? [{ id: ENV, projectId: PROJ, domain: 'app.customer.example', isActive: true }] : [])),
    findOne: jest.fn(async ({ where }: any) => (where.projectId === PROJ && where.id === ENV ? { id: ENV, projectId: PROJ } : null)),
  },
  SyntheticCheck: mockChecks,
  SyntheticResult: Object.assign(mockResults, { createQueryBuilder: resultsQb }),
  AuditLog: mockAudit,
  Role: { findOne: jest.fn(async () => null) },
};
const mockGetRepository = (e: any) => mockRepos[typeof e === 'string' ? e : e.name];

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({ getRepository: mockGetRepository, query: jest.fn(async () => []) })),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import syntheticsRouter, { runnerOutcome } from '../../../src/routes/synthetics';
import { clearPermissionCache } from '../../../src/middleware/auth';
import { setAlertEventTestHook, AlertEvent } from '../../../src/lib/alert-events';
import { runnerToken } from '../../../src/lib/synthetic-checks';
import { setSyntheticK8sOpsForTests } from '../../../src/lib/synthetic-k8s';
import { setUploadStoreForTests, UploadStore } from '../../../src/lib/upload-store';
import fs from 'fs';
import dns from 'dns';

const JWT_SECRET = 'synthetics-test-jwt-secret-0123456789abcd';
const as = (id: string) => ({ Authorization: `Bearer ${jwt.sign({ id, amr: ['pwd'] }, JWT_SECRET, { expiresIn: '1h' })}` });

const stored: Record<string, Buffer> = {};
const uploadStore: UploadStore = {
  kind: 's3', bucket: 'platform-uploads',
  async put(key, filePath) { stored[key] = fs.readFileSync(filePath); },
  async get(key) { return stored[key] ? Readable.from(stored[key]) : null; },
  async delete(key) { delete stored[key]; },
  presign: () => null,
};
let runnerEnabled = false;
const k8sCalls: string[] = [];
const events: AlertEvent[] = [];

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = MASTER_KEY;
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api', syntheticsRouter);
  setUploadStoreForTests(uploadStore);
  setAlertEventTestHook((e) => events.push(e));
});
afterAll(() => { setUploadStoreForTests(null); setAlertEventTestHook(null); });

beforeEach(() => {
  clearPermissionCache();
  mockChecks.rows = [];
  mockResults.rows = [];
  mockAudit.rows = [];
  events.length = 0;
  k8sCalls.length = 0;
  runnerEnabled = false;
  setSyntheticK8sOpsForTests(k8sOps);
});
const k8sOps = {
    readRunnerConfig: async () => (runnerEnabled ? { browser: 'enabled', image: 'ghcr.io/example/runner:1' } : null),
    applyProbe: async (p) => { k8sCalls.push(`probe:${p.metadata.name}`); },
    deleteProbe: async (n) => { k8sCalls.push(`-probe:${n}`); },
    listProbeNames: async () => [],
    applyCronJob: async (cj) => { k8sCalls.push(`cron:${cj.metadata.name}`); },
    deleteCronJob: async (n) => { k8sCalls.push(`-cron:${n}`); },
    listCronJobNames: async () => [],
} as any;
/** Enable the browser runner (and drop the 60 s runtime cache). */
function enableRunner() {
  runnerEnabled = true;
  setSyntheticK8sOpsForTests(k8sOps);
}

const httpCheck = {
  name: 'Home', type: 'http', intervalSeconds: 60,
  config: { url: 'https://app.customer.example/health', headers: { Authorization: 'Bearer {{secret.TOKEN}}' }, assertions: [{ source: 'status', comparison: 'eq', target: 200 }] },
  secrets: { TOKEN: 'super-secret-value' },
};
const create = (body: any = httpCheck, user = 'uid-dev', project = PROJ) =>
  request(app).post(`/api/projects/${project}/synthetics/checks`).set(as(user)).send(body);

describe('permissions', () => {
  it('developer creates (audited); secrets are write-only', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.check).toMatchObject({ name: 'Home', type: 'http', projectId: PROJ, secretNames: ['TOKEN'], lastStatus: 'unknown' });
    expect(JSON.stringify(r.body)).not.toContain('super-secret-value');
    expect(r.body.check).not.toHaveProperty('secretsEncrypted');
    expect(mockChecks.rows[0].secretsEncrypted).toBeTruthy();
    expect(mockChecks.rows[0].secretsEncrypted).not.toContain('super-secret-value');
    expect(mockAudit.rows).toHaveLength(1);
    expect(mockAudit.rows[0]).toMatchObject({ action: 'synthetics.create', userId: 'uid-dev', targetType: 'synthetic_check' });
    expect(JSON.stringify(mockAudit.rows[0])).not.toContain('super-secret-value');

    const list = await request(app).get(`/api/projects/${PROJ}/synthetics/checks`).set(as('uid-view'));
    expect(list.status).toBe(200);
    expect(list.body.checks).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('super-secret-value');
  });

  it('viewers read but cannot change; outsiders get nothing', async () => {
    const id = (await create()).body.check.id;
    expect((await create(httpCheck, 'uid-view')).status).toBe(403);
    expect((await request(app).put(`/api/projects/${PROJ}/synthetics/checks/${id}`).set(as('uid-view')).send(httpCheck)).status).toBe(403);
    expect((await request(app).delete(`/api/projects/${PROJ}/synthetics/checks/${id}`).set(as('uid-view'))).status).toBe(403);
    expect((await request(app).post(`/api/projects/${PROJ}/synthetics/checks/${id}/run`).set(as('uid-view'))).status).toBe(403);
    expect((await request(app).get(`/api/projects/${PROJ}/synthetics/checks/${id}`).set(as('uid-view'))).status).toBe(200);
    for (const path of ['checks', `checks/${id}`, `checks/${id}/results`, 'status-feed']) {
      expect((await request(app).get(`/api/projects/${PROJ}/synthetics/${path}`).set(as('uid-out'))).status).toBe(403);
    }
    expect((await request(app).get(`/api/projects/${PROJ}/synthetics/checks`)).status).toBe(401);
  });

  it('a check is only reachable through its own project', async () => {
    const id = (await create(httpCheck, 'uid-admin')).body.check.id;
    expect((await request(app).get(`/api/projects/${OTHER}/synthetics/checks/${id}`).set(as('uid-admin'))).status).toBe(404);
  });
});

describe('validation and SSRF', () => {
  it('refuses cluster-internal targets', async () => {
    const r = await create({ ...httpCheck, config: { url: 'http://platform-api.platform.svc:3000/api/health' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/internal/);
    expect((await create({ ...httpCheck, config: { url: 'http://169.254.169.254/latest' } })).status).toBe(400);
    expect(mockChecks.rows).toHaveLength(0);
  });

  it('browser checks need the runner (full profile)', async () => {
    const browser = { name: 'Shop', type: 'browser', intervalSeconds: 900, timeoutMs: 60_000, config: { steps: [{ action: 'goto', url: 'https://shop.example.com/' }] } };
    expect((await create(browser)).status).toBe(409);
    enableRunner();
    const r = await create(browser);
    expect(r.status).toBe(201);
    expect(k8sCalls).toEqual([`cron:synthetic-${r.body.check.id}`]);
  });

  it('caps checks per project', async () => {
    process.env.SYNTHETICS_MAX_CHECKS_PER_PROJECT = '1';
    try {
      expect((await create()).status).toBe(201);
      expect((await create()).status).toBe(409);
    } finally {
      delete process.env.SYNTHETICS_MAX_CHECKS_PER_PROJECT;
    }
  });
});

describe('update / delete', () => {
  it('update keeps secrets unless changed; disabling resolves an open alert; delete cleans up', async () => {
    const id = (await create()).body.check.id;
    const row = mockChecks.rows[0];
    const before = row.secretsEncrypted;
    const upd = await request(app).put(`/api/projects/${PROJ}/synthetics/checks/${id}`).set(as('uid-dev')).send({ ...httpCheck, secrets: undefined, name: 'Home v2' });
    expect(upd.status).toBe(200);
    expect(upd.body.check).toMatchObject({ name: 'Home v2', secretNames: ['TOKEN'] });
    expect(mockChecks.rows[0].secretsEncrypted).toBe(before);

    mockChecks.rows[0].alertState = 'firing';
    await request(app).put(`/api/projects/${PROJ}/synthetics/checks/${id}`).set(as('uid-dev')).send({ ...httpCheck, enabled: false });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'resolved', source: 'synthetics', dedupeKey: `synthetic:${id}` });
    expect(mockChecks.rows[0]).toMatchObject({ enabled: false, nextRunAt: null, alertState: 'ok' });

    mockResults.rows.push({ id: 'r1', checkId: id, projectId: PROJ, status: 'fail', startedAt: new Date(), screenshotKey: 'synthetics/x.png' });
    stored['synthetics/x.png'] = Buffer.from('png');
    const del = await request(app).delete(`/api/projects/${PROJ}/synthetics/checks/${id}`).set(as('uid-dev'));
    expect(del.status).toBe(200);
    expect(mockChecks.rows).toHaveLength(0);
    expect(mockResults.rows).toHaveLength(0);
    expect(stored['synthetics/x.png']).toBeUndefined();
    expect(mockAudit.rows.map((a) => a.action)).toEqual(['synthetics.create', 'synthetics.update', 'synthetics.update', 'synthetics.delete']);
  });
});

describe('results, run-now and status feed', () => {
  it('run now records a result (target refused by the SSRF guard → failed run)', async () => {
    // No real DNS in unit tests: the name resolves to the metadata address.
    const lookup = jest.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as any);
    const id = (await create({ ...httpCheck, config: { url: 'https://rebound.example.com/' }, secrets: undefined })).body.check.id;
    const r = await request(app).post(`/api/projects/${PROJ}/synthetics/checks/${id}/run`).set(as('uid-dev'));
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ status: 'fail', checkId: id });
    const hist = await request(app).get(`/api/projects/${PROJ}/synthetics/checks/${id}/results`).set(as('uid-view'));
    expect(hist.status).toBe(200);
    expect(hist.body.results).toHaveLength(1);
    expect(hist.body.results[0]).toMatchObject({ status: 'fail', hasScreenshot: false });
    expect(hist.body.results[0]).not.toHaveProperty('screenshotKey');
    expect(hist.body.results[0].error).toMatch(/forbidden address/);
    lookup.mockRestore();
  });

  it('status feed returns the public-safe shape', async () => {
    await create();
    const r = await request(app).get(`/api/projects/${PROJ}/synthetics/status-feed`).set(as('uid-view'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ projectId: PROJ, status: 'unknown' });
    expect(r.body.components[0]).toMatchObject({ name: 'Home', type: 'http', status: 'unknown', uptime: { '24h': null } });
    expect(JSON.stringify(r.body)).not.toContain('app.customer.example');
  });
});

describe('browser runner endpoints', () => {
  async function browserCheck() {
    enableRunner();
    const r = await create({
      name: 'Shop', type: 'browser', intervalSeconds: 900, timeoutMs: 60_000,
      config: { steps: [{ action: 'goto', url: 'https://shop.example.com/' }, { action: 'fill', selector: '#pw', value: '{{secret.PW}}' }] },
      secrets: { PW: 'browser-pass-1' },
    });
    return r.body.check.id as string;
  }
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-image-data')]);

  it('requires the per-check token', async () => {
    const id = await browserCheck();
    expect((await request(app).get(`/api/synthetics/runner/checks/${id}`)).status).toBe(401);
    expect((await request(app).get(`/api/synthetics/runner/checks/${id}`).set('Authorization', `Bearer ${runnerToken(OTHER)}`)).status).toBe(401);
    // A user session is not a runner token.
    expect((await request(app).get(`/api/synthetics/runner/checks/${id}`).set(as('uid-admin'))).status).toBe(401);
    const ok = await request(app).get(`/api/synthetics/runner/checks/${id}`).set('Authorization', `Bearer ${runnerToken(id)}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id, enabled: true, steps: [{ action: 'goto' }, { action: 'fill' }], secrets: { PW: 'browser-pass-1' } });
  });

  it('stores a failed run with its screenshot; viewers can fetch it', async () => {
    const id = await browserCheck();
    const token = `Bearer ${runnerToken(id)}`;
    for (let i = 0; i < 2; i++) {
      const r = await request(app).post(`/api/synthetics/runner/checks/${id}/results`).set('Authorization', token).send({
        status: 'fail', latencyMs: 3456, error: 'Timeout waiting for #pw after typing browser-pass-1',
        steps: [{ name: 'goto', status: 'pass', latencyMs: 900 }, { name: 'fill #pw', status: 'fail', error: 'timeout' }],
        screenshot: PNG.toString('base64'),
      });
      expect(r.status).toBe(201);
      expect(r.body.screenshotStored).toBe(true);
    }
    expect(mockResults.rows).toHaveLength(2);
    const row = mockResults.rows[0];
    expect(row.screenshotKey).toMatch(new RegExp(`^synthetics/${PROJ}/${id}/.+\\.png$`));
    expect(row.error).toContain('[redacted]');
    expect(row.error).not.toContain('browser-pass-1');
    // Two consecutive failures → alert.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'firing', source: 'synthetics', dedupeKey: `synthetic:${id}` });

    const shot = await request(app).get(`/api/projects/${PROJ}/synthetics/results/${row.id}/screenshot`).set(as('uid-view')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(shot.status).toBe(200);
    expect(shot.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(shot.body, PNG)).toBe(0);
    expect((await request(app).get(`/api/projects/${PROJ}/synthetics/results/${row.id}/screenshot`).set(as('uid-out'))).status).toBe(403);
  });

  it('ignores non-PNG screenshots and reports for non-browser checks', async () => {
    const id = await browserCheck();
    const r = await request(app).post(`/api/synthetics/runner/checks/${id}/results`).set('Authorization', `Bearer ${runnerToken(id)}`)
      .send({ status: 'fail', screenshot: Buffer.from('<svg onload=alert(1)>').toString('base64') });
    expect(r.body.screenshotStored).toBe(false);
    const httpId = (await create()).body.check.id;
    expect((await request(app).post(`/api/synthetics/runner/checks/${httpId}/results`).set('Authorization', `Bearer ${runnerToken(httpId)}`).send({ status: 'pass' })).status).toBe(404);
  });

  it('runnerOutcome bounds and normalises the report', () => {
    const o = runnerOutcome({ status: 'weird', steps: Array.from({ length: 80 }, () => ({ name: 'x'.repeat(500), status: 'nope' })) }, {});
    expect(o.status).toBe('fail');
    expect(o.steps).toHaveLength(50);
    expect(o.steps![0]).toMatchObject({ status: 'fail' });
    expect(o.steps![0].name).toHaveLength(100);
  });
});
