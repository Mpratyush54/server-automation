/**
 * #29 — Environment tab API: merged GET (masking, viewer sees keys/types only), PUT plain/secret,
 * plain→secret / secret→plain moves in one transaction, permissions, reveal audit, and the env a
 * workload receives (GET /sdk/config) staying identical across a conversion.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(), loadFromDefault: jest.fn(), makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(), AppsV1Api: jest.fn(), NetworkingV1Api: jest.fn(), CustomObjectsApi: jest.fn(),
}));
jest.mock('../../../src/lib/project-db-ensure', () => ({
  resolveProjectDbCredentials: jest.fn(),
  ensureProjectDatabases: jest.fn(),
}));

import { MemoryRepo } from '../../helpers/memory-repo';

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENV_STG = 'eeeeeeee-0000-4000-8000-000000000001';
const ENV_PROD = 'eeeeeeee-0000-4000-8000-000000000002';
const MASTER_KEY = 'c'.repeat(64);
const SDK_TOKEN = 'sdk_live_environmenttest0000000000000000';

const mockUsers: Record<string, any> = {
  'uid-admin': { id: 'uid-admin', role: 'admin', roleId: null, name: 'Admin', email: 'a@io', isActive: true },
  'uid-devops': { id: 'uid-devops', role: 'devops', roleId: null, name: 'Ops', email: 'o@io', isActive: true },
  'uid-tl': { id: 'uid-tl', role: 'tech_lead', roleId: null, name: 'Lead', email: 'tl@io', isActive: true },
  'uid-dev': { id: 'uid-dev', role: 'developer', roleId: null, name: 'Dev', email: 'dev@io', isActive: true },
  'uid-view': { id: 'uid-view', role: 'viewer', roleId: null, name: 'View', email: 'v@io', isActive: true },
  // Global tech lead who is only a *viewer* on this project.
  'uid-tl-viewer': { id: 'uid-tl-viewer', role: 'tech_lead', roleId: null, name: 'LV', email: 'lv@io', isActive: true },
  'uid-out': { id: 'uid-out', role: 'tech_lead', roleId: null, name: 'Out', email: 'out@io', isActive: true },
};
const mockMembers = [
  { projectId: PROJ, userId: 'uid-tl', role: 'devops' },
  { projectId: PROJ, userId: 'uid-dev', role: 'developer' },
  { projectId: PROJ, userId: 'uid-view', role: 'viewer' },
  { projectId: PROJ, userId: 'uid-tl-viewer', role: 'viewer' },
];

const mockConfigs = new MemoryRepo<any>(() => ({ isSecret: false, changedAt: new Date(), createdAt: new Date() }));
const mockSecrets = new MemoryRepo<any>(() => ({ isActive: true, version: 1, updatedAt: new Date(), createdAt: new Date() }));
const mockVersions = new MemoryRepo<any>(() => ({ createdAt: new Date() }));
const mockAudit = new MemoryRepo<any>();
const mockTx = { failOn: null as null | 'configDelete' };

const mockRepos: Record<string, any> = {
  User: {
    findOne: jest.fn(async ({ where }: any) => mockUsers[where.id] || null),
    find: jest.fn(async () => Object.values(mockUsers)),
  },
  ProjectMember: {
    findOne: jest.fn(async ({ where }: any) =>
      mockMembers.find((m) => m.projectId === where.projectId && m.userId === where.userId) || null),
  },
  Environment: {
    findOne: jest.fn(async ({ where }: any) => {
      const envs = [
        { id: ENV_STG, name: 'staging', projectId: PROJ },
        { id: ENV_PROD, name: 'production', projectId: PROJ },
      ];
      return envs.find((e) => e.projectId === where.projectId && (where.id ? e.id === where.id : e.name === where.name)) || null;
    }),
  },
  Project: { findOne: jest.fn(async ({ where }: any) => (where.id === PROJ ? { id: PROJ, name: 'demo' } : null)) },
  SdkCredential: {
    findOne: jest.fn(async ({ where }: any) =>
      (where.token === SDK_TOKEN ? { id: 'c', token: SDK_TOKEN, projectId: PROJ, status: 'active' } : null)),
  },
  Role: { findOne: jest.fn(async () => null) },
  ProjectConfig: mockConfigs,
  Secret: mockSecrets,
  SecretVersion: mockVersions,
  AuditLog: mockAudit,
};
const mockGetRepository = (e: any) => mockRepos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null), find: jest.fn(async () => []) };

/** Transaction emulation: snapshot the stores, restore them if the callback throws. */
async function mockTransaction(fn: (m: any) => Promise<any>) {
  const stores = [mockConfigs, mockSecrets, mockVersions];
  const snap = stores.map((s) => s.rows.map((r) => ({ ...r })));
  const manager = {
    getRepository: (e: any) => {
      const repo = mockGetRepository(e);
      if (repo === mockConfigs && mockTx.failOn === 'configDelete') {
        return Object.assign(Object.create(mockConfigs), { delete: async () => { throw new Error('simulated failure'); } });
      }
      return repo;
    },
  };
  try {
    return await fn(manager);
  } catch (err) {
    stores.forEach((s, i) => { s.rows = snap[i]; });
    throw err;
  }
}

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({ getRepository: mockGetRepository, transaction: mockTransaction })),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import environmentRouter from '../../../src/routes/environment';
import secretsRouter from '../../../src/routes/secrets';
import sdkRouter from '../../../src/routes/sdk';
import { clearPermissionCache } from '../../../src/middleware/auth';
import { encryptValue, decryptValue } from '../../../src/lib/secrets-encryption';
import { buildEnvironmentRows } from '../../../src/lib/environment-vars';

const JWT_SECRET = 'environment-test-jwt-secret-0123456789ab';
const sign = (id: string, mfa = false) => jwt.sign(
  mfa ? { id, amr: ['pwd', 'otp', 'mfa'], auth_time: Math.floor(Date.now() / 1000) } : { id, amr: ['pwd'] },
  JWT_SECRET, { expiresIn: '1h' },
);
const as = (id: string, mfa = false) => ({ Authorization: `Bearer ${sign(id, mfa)}` });
const flush = () => new Promise((r) => setImmediate(r));

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = MASTER_KEY;
  app = express();
  app.use(express.json());
  app.use('/api', environmentRouter);
  app.use('/api', secretsRouter);
  app.use('/api', sdkRouter);
});

function seed() {
  mockConfigs.rows = [
    { id: 'c1', projectId: PROJ, key: 'LOG_LEVEL', value: 'info', environmentId: null, isSecret: false, changedById: 'uid-tl', changedAt: new Date('2026-01-01') },
    { id: 'c2', projectId: PROJ, key: 'API_URL', value: 'https://stg.example.test', environmentId: ENV_STG, isSecret: false, changedById: null, changedAt: new Date() },
    { id: 'c3', projectId: PROJ, key: 'API_URL', value: 'https://prod.example.test', environmentId: ENV_PROD, isSecret: false, changedById: null, changedAt: new Date() },
    // Conflict: same key/scope also exists as a secret below.
    { id: 'c4', projectId: PROJ, key: 'DUP', value: 'plain-dup', environmentId: ENV_STG, isSecret: false, changedById: null, changedAt: new Date() },
    { id: 'c5', projectId: OTHER, key: 'OTHER_KEY', value: 'other-plain', environmentId: null, isSecret: false, changedById: null, changedAt: new Date() },
  ];
  mockSecrets.rows = [
    { id: 's1', projectId: PROJ, key: 'DB_PASSWORD', encryptedValue: encryptValue('hunter2', MASTER_KEY), environmentId: ENV_STG, version: 3, isActive: true, createdById: 'uid-devops', updatedAt: new Date() },
    { id: 's2', projectId: PROJ, key: 'DUP', encryptedValue: encryptValue('secret-dup', MASTER_KEY), environmentId: ENV_STG, version: 1, isActive: true, createdById: null, updatedAt: new Date() },
    { id: 's3', projectId: PROJ, key: 'OLD', encryptedValue: encryptValue('gone', MASTER_KEY), environmentId: null, version: 1, isActive: false, createdById: null, updatedAt: new Date() },
  ];
  mockVersions.rows = [];
  mockAudit.rows = [];
}

beforeEach(() => {
  clearPermissionCache();
  mockTx.failOn = null;
  seed();
});

const plainRow = (key: string, environmentId: string | null = null) =>
  mockConfigs.rows.find((r) => r.projectId === PROJ && r.key === key && (r.environmentId || null) === environmentId);
const secretRow = (key: string, environmentId: string | null = null) =>
  mockSecrets.rows.find((r) => r.projectId === PROJ && r.key === key && (r.environmentId || null) === environmentId && r.isActive);

describe('GET /projects/:projectId/environment', () => {
  it('merges plain + secret rows, masks secrets, and flags conflicts', async () => {
    const r = await request(app).get(`/api/projects/${PROJ}/environment`).set(as('uid-devops'));
    expect(r.status).toBe(200);
    const rows = r.body.variables;
    const log = rows.find((v: any) => v.key === 'LOG_LEVEL');
    expect(log).toMatchObject({ type: 'plain', value: 'info', masked: false, scope: 'global', updatedBy: 'Lead' });
    const db = rows.find((v: any) => v.key === 'DB_PASSWORD');
    expect(db).toMatchObject({ type: 'secret', value: null, masked: true, version: 3, secretId: 's1', environmentId: ENV_STG, updatedBy: 'Ops' });
    expect(rows.filter((v: any) => v.key === 'DUP').every((v: any) => v.conflict)).toBe(true);
    expect(r.body.conflicts).toBe(2);
    expect(rows.find((v: any) => v.key === 'OLD')).toBeUndefined(); // inactive secret
    const body = JSON.stringify(r.body);
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain('secret-dup');
    expect(body).not.toContain('other-plain'); // other project's rows never leak
    expect(r.body.capabilities).toMatchObject({ canReadValues: true, canReveal: true, canWriteSecret: true });
  });

  it('environment view = global rows + rows for that environment (by id or name)', async () => {
    for (const env of [ENV_STG, 'staging']) {
      const r = await request(app).get(`/api/projects/${PROJ}/environment?environmentId=${env}`).set(as('uid-devops'));
      expect(r.status).toBe(200);
      const keys = r.body.variables.map((v: any) => `${v.key}:${v.environmentId || 'global'}`);
      expect(keys).toEqual(expect.arrayContaining(['LOG_LEVEL:global', `API_URL:${ENV_STG}`, `DB_PASSWORD:${ENV_STG}`]));
      expect(keys).not.toContain(`API_URL:${ENV_PROD}`);
      expect(r.body.environment).toEqual({ id: ENV_STG, name: 'staging' });
    }
    const g = await request(app).get(`/api/projects/${PROJ}/environment?environmentId=global`).set(as('uid-devops'));
    expect(g.body.variables.map((v: any) => v.key)).toEqual(['LOG_LEVEL']);
  });

  it('viewers see keys and types only (no plain values, no capabilities)', async () => {
    for (const uid of ['uid-view', 'uid-tl-viewer']) {
      const r = await request(app).get(`/api/projects/${PROJ}/environment`).set(as(uid));
      expect(r.status).toBe(200);
      expect(r.body.variables.length).toBeGreaterThan(0);
      for (const v of r.body.variables) {
        expect(v.value).toBeNull();
        expect(v.masked).toBe(true);
        expect(['plain', 'secret']).toContain(v.type);
      }
      expect(JSON.stringify(r.body)).not.toContain('info');
      expect(Object.values(r.body.capabilities).every((c) => c === false)).toBe(true);
    }
  });

  it('developers read plain values but cannot reveal or write', async () => {
    const r = await request(app).get(`/api/projects/${PROJ}/environment`).set(as('uid-dev'));
    expect(r.status).toBe(200);
    expect(r.body.variables.find((v: any) => v.key === 'LOG_LEVEL').value).toBe('info');
    expect(r.body.capabilities).toMatchObject({ canReadValues: true, canReveal: false, canWritePlain: false, canWriteSecret: false });
  });

  it('403 for non-members', async () => {
    const r = await request(app).get(`/api/projects/${PROJ}/environment`).set(as('uid-out'));
    expect(r.status).toBe(403);
  });

  it('401 without a token', async () => {
    const r = await request(app).get(`/api/projects/${PROJ}/environment`);
    expect(r.status).toBe(401);
  });
});

describe('PUT /projects/:projectId/environment/:key', () => {
  it('creates a plain value in config storage (audited, value not logged)', async () => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/FEATURE_X`).set(as('uid-tl'))
      .send({ environmentId: ENV_STG, value: 'on', secret: false });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'plain', status: 'created', convertedFrom: null });
    expect(plainRow('FEATURE_X', ENV_STG)).toMatchObject({ value: 'on', changedById: 'uid-tl', isSecret: false });
    expect(secretRow('FEATURE_X', ENV_STG)).toBeUndefined();
    expect(mockAudit.rows).toEqual([expect.objectContaining({ action: 'config.update', userId: 'uid-tl' })]);
    expect(JSON.stringify(mockAudit.rows)).not.toContain('"on"');
  });

  it('creates and updates an encrypted secret with version history', async () => {
    const c = await request(app).put(`/api/projects/${PROJ}/environment/STRIPE_KEY`).set(as('uid-tl'))
      .send({ value: 'sk-1', secret: true });
    expect(c.status).toBe(201);
    const row = secretRow('STRIPE_KEY');
    expect(row.encryptedValue).not.toContain('sk-1');
    expect(decryptValue(row.encryptedValue, MASTER_KEY)).toBe('sk-1');
    expect(plainRow('STRIPE_KEY')).toBeUndefined();

    const u = await request(app).put(`/api/projects/${PROJ}/environment/STRIPE_KEY`).set(as('uid-tl'))
      .send({ value: 'sk-2', secret: true });
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ type: 'secret', status: 'updated', version: 2 });
    expect(decryptValue(secretRow('STRIPE_KEY').encryptedValue, MASTER_KEY)).toBe('sk-2');
    expect(mockVersions.rows).toHaveLength(1);
    expect(mockAudit.rows.map((a) => a.action)).toEqual(['secrets.create', 'secrets.update']);
    expect(JSON.stringify(mockAudit.rows)).not.toMatch(/sk-1|sk-2/);
  });

  it('plain → secret moves the value and deletes the plaintext row', async () => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/LOG_LEVEL`).set(as('uid-tl'))
      .send({ secret: true }); // no value: keep the stored one
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'secret', convertedFrom: 'plain' });
    expect(plainRow('LOG_LEVEL')).toBeUndefined();
    expect(mockConfigs.rows.some((c) => c.value === 'info')).toBe(false);
    expect(decryptValue(secretRow('LOG_LEVEL').encryptedValue, MASTER_KEY)).toBe('info');
  });

  it('plain → secret is atomic: a failed plaintext delete rolls back the secret insert', async () => {
    mockTx.failOn = 'configDelete';
    const r = await request(app).put(`/api/projects/${PROJ}/environment/LOG_LEVEL`).set(as('uid-tl'))
      .send({ value: 'debug', secret: true });
    expect(r.status).toBe(400);
    expect(plainRow('LOG_LEVEL')).toMatchObject({ value: 'info' });
    expect(secretRow('LOG_LEVEL')).toBeUndefined();
    expect(mockAudit.rows).toHaveLength(0);
  });

  it('writing a secret resolves a plain/secret conflict', async () => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/DUP`).set(as('uid-tl'))
      .send({ environmentId: ENV_STG, value: 'final', secret: true });
    expect(r.status).toBe(200);
    expect(plainRow('DUP', ENV_STG)).toBeUndefined();
    expect(decryptValue(secretRow('DUP', ENV_STG).encryptedValue, MASTER_KEY)).toBe('final');
  });

  it('secret → plain needs a recent MFA step-up', async () => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/DB_PASSWORD`).set(as('uid-devops'))
      .send({ environmentId: ENV_STG, secret: false });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('step_up_required');
    expect(secretRow('DB_PASSWORD', ENV_STG)).toBeDefined();
    expect(plainRow('DB_PASSWORD', ENV_STG)).toBeUndefined();
  });

  it('secret → plain with step-up moves the value and deactivates the secret', async () => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/DB_PASSWORD`).set(as('uid-devops', true))
      .send({ environmentId: ENV_STG, secret: false });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'plain', convertedFrom: 'secret' });
    expect(plainRow('DB_PASSWORD', ENV_STG)).toMatchObject({ value: 'hunter2' });
    expect(secretRow('DB_PASSWORD', ENV_STG)).toBeUndefined();
    expect(mockSecrets.rows.find((s) => s.id === 's1').isActive).toBe(false);
  });

  it('secret → plain is refused without secrets.delete (tech lead)', async () => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/DB_PASSWORD`).set(as('uid-tl', true))
      .send({ environmentId: ENV_STG, value: 'x', secret: false });
    expect(r.status).toBe(403);
    expect(secretRow('DB_PASSWORD', ENV_STG)).toBeDefined();
  });

  it.each([
    ['developer (no config.update / secrets.create)', 'uid-dev', false],
    ['developer secret write', 'uid-dev', true],
    ['project viewer', 'uid-view', false],
    ['global tech lead who is a project viewer', 'uid-tl-viewer', true],
    ['non-member', 'uid-out', true],
  ])('403 for %s', async (_label, uid, secret) => {
    const r = await request(app).put(`/api/projects/${PROJ}/environment/NEW_KEY`).set(as(uid as string))
      .send({ value: 'v', secret });
    expect(r.status).toBe(403);
    expect(plainRow('NEW_KEY')).toBeUndefined();
    expect(secretRow('NEW_KEY')).toBeUndefined();
  });

  it('validates key and body', async () => {
    const bad = await request(app).put(`/api/projects/${PROJ}/environment/1BAD KEY`).set(as('uid-admin')).send({ value: 'v', secret: false });
    expect(bad.status).toBe(400);
    const noFlag = await request(app).put(`/api/projects/${PROJ}/environment/GOOD`).set(as('uid-admin')).send({ value: 'v' });
    expect(noFlag.status).toBe(400);
    const nonString = await request(app).put(`/api/projects/${PROJ}/environment/GOOD`).set(as('uid-admin')).send({ value: 5, secret: false });
    expect(nonString.status).toBe(400);
    const noValue = await request(app).put(`/api/projects/${PROJ}/environment/BRAND_NEW`).set(as('uid-admin')).send({ secret: true });
    expect(noValue.status).toBe(400);
  });
});

describe('DELETE /projects/:projectId/environment/:key', () => {
  it('requires config.delete for plain rows (tech lead lacks it)', async () => {
    const r = await request(app).delete(`/api/projects/${PROJ}/environment/LOG_LEVEL?type=plain`).set(as('uid-tl'));
    expect(r.status).toBe(403);
    expect(plainRow('LOG_LEVEL')).toBeDefined();
  });

  it('deletes plain and secret rows (audited) and 404s on missing', async () => {
    const p = await request(app).delete(`/api/projects/${PROJ}/environment/DUP?type=plain&environmentId=${ENV_STG}`).set(as('uid-devops'));
    expect(p.status).toBe(200);
    expect(plainRow('DUP', ENV_STG)).toBeUndefined();
    const s = await request(app).delete(`/api/projects/${PROJ}/environment/DUP?type=secret&environmentId=${ENV_STG}`).set(as('uid-devops'));
    expect(s.status).toBe(200);
    expect(secretRow('DUP', ENV_STG)).toBeUndefined();
    expect(mockAudit.rows.map((a) => a.action)).toEqual(['config.delete', 'secrets.delete']);
    const missing = await request(app).delete(`/api/projects/${PROJ}/environment/NOPE?type=plain`).set(as('uid-devops'));
    expect(missing.status).toBe(404);
  });
});

describe('reveal stays on the existing endpoint', () => {
  it('POST /secrets/reveal with step-up returns the value and writes secrets.reveal', async () => {
    const r = await request(app).post(`/api/projects/${PROJ}/secrets/reveal`).set(as('uid-devops', true))
      .send({ key: 'DB_PASSWORD', environmentId: ENV_STG });
    expect(r.status).toBe(200);
    expect(r.body.value).toBe('hunter2');
    await flush();
    expect(mockAudit.rows).toEqual([expect.objectContaining({ action: 'secrets.reveal', targetId: 's1', userId: 'uid-devops' })]);
  });
});

describe('workload env (GET /sdk/config) is unchanged by the Environment tab', () => {
  const sdk = { Authorization: `Bearer ${SDK_TOKEN}` };
  const envFor = async (env?: string) => {
    const q = env ? `&environmentId=${env}` : '';
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}${q}`).set(sdk);
    expect(r.status).toBe(200);
    return r.body;
  };

  it('plain → secret → plain keeps the exact same env for every environment', async () => {
    const before = { all: await envFor(), stg: await envFor(ENV_STG), prod: await envFor(ENV_PROD) };
    expect(before.stg).toMatchObject({ LOG_LEVEL: 'info', API_URL: 'https://stg.example.test', DB_PASSWORD: 'hunter2' });

    const toSecret = await request(app).put(`/api/projects/${PROJ}/environment/LOG_LEVEL`).set(as('uid-tl')).send({ secret: true });
    expect(toSecret.status).toBe(201);
    expect(await envFor()).toEqual(before.all);
    // Per-environment scoped key. (Without environmentId the SDK merges every environment's rows
    // and same-key collisions are order-dependent — pre-existing behaviour, not covered here.)
    const apiToSecret = await request(app).put(`/api/projects/${PROJ}/environment/API_URL`).set(as('uid-tl'))
      .send({ environmentId: ENV_STG, secret: true });
    expect(apiToSecret.status).toBe(201);
    expect(await envFor(ENV_STG)).toEqual(before.stg);
    expect(await envFor(ENV_PROD)).toEqual(before.prod);

    const back = await request(app).put(`/api/projects/${PROJ}/environment/LOG_LEVEL`).set(as('uid-devops', true)).send({ secret: false });
    expect(back.status).toBe(201);
    expect(await envFor(ENV_STG)).toEqual(before.stg);
    expect(await envFor(ENV_PROD)).toEqual(before.prod);
  });
});

describe('buildEnvironmentRows', () => {
  it('never includes secret values and masks legacy isSecret config rows', () => {
    const rows = buildEnvironmentRows(
      [{ key: 'LEGACY', value: 'plaintext-but-flagged', environmentId: null, isSecret: true, changedById: null, changedAt: new Date() }],
      [{ id: 'x', key: 'S', environmentId: null, version: 1, createdById: null, updatedAt: new Date(), isActive: true }],
      { filter: {}, canReadValues: true },
    );
    expect(rows).toEqual([
      expect.objectContaining({ key: 'LEGACY', type: 'plain', value: null, masked: true, legacyMasked: true }),
      expect.objectContaining({ key: 'S', type: 'secret', value: null, masked: true }),
    ]);
  });
});
