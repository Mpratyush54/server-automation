/**
 * H4 regressions — GET /config requires projectId + membership, masks secrets
 * unless the caller holds secrets.reveal (audited), and honours environmentId.
 */
const PROJ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ENV_DEV = 'eeeeeeee-0000-4000-8000-000000000001';
const ENV_PROD = 'eeeeeeee-0000-4000-8000-000000000002';
const MASTER_KEY = 'b'.repeat(64);

import { encryptValue } from '../../../src/lib/secrets-encryption';

const users: Record<string, any> = {
  'uid-devops': { id: 'uid-devops', role: 'devops', roleId: null, name: 'D', email: 'd@io', isActive: true },
  'uid-dev': { id: 'uid-dev', role: 'developer', roleId: null, name: 'Dev', email: 'dev@io', isActive: true },
  'uid-view': { id: 'uid-view', role: 'viewer', roleId: null, name: 'V', email: 'v@io', isActive: true },
};
const members = [
  { projectId: PROJ_A, userId: 'uid-dev', role: 'developer' },
  { projectId: PROJ_A, userId: 'uid-view', role: 'viewer' },
];
const configs = [
  { projectId: PROJ_A, key: 'PLAIN', value: 'a-plain', isSecret: false, environmentId: null },
  { projectId: PROJ_A, key: 'DEV_ONLY', value: 'dev', isSecret: false, environmentId: ENV_DEV },
  { projectId: PROJ_A, key: 'PROD_ONLY', value: 'prod', isSecret: false, environmentId: ENV_PROD },
  { projectId: PROJ_B, key: 'B_PLAIN', value: 'b-plain', isSecret: false, environmentId: null },
];
let secrets: any[] = [];
const auditSave = jest.fn(async (d: any) => d);

const repos: Record<string, any> = {
  User: { findOne: jest.fn(async ({ where }: any) => users[where.id] || null) },
  Project: { findOne: jest.fn(async ({ where }: any) => ([PROJ_A, PROJ_B].includes(where.id) ? { id: where.id, name: where.id } : null)) },
  ProjectMember: {
    findOne: jest.fn(async ({ where }: any) =>
      members.find((m) => m.projectId === where.projectId && m.userId === where.userId) || null),
  },
  Environment: { findOne: jest.fn(async () => null) },
  // Emulate TypeORM: undefined where-keys are dropped (that's why projectId must be mandatory).
  ProjectConfig: {
    find: jest.fn(async ({ where }: any) => configs.filter((c) => where.projectId === undefined || c.projectId === where.projectId)),
  },
  Secret: {
    find: jest.fn(async ({ where }: any) => secrets.filter((s) => where.projectId === undefined || s.projectId === where.projectId)),
  },
  AuditLog: { create: jest.fn((d: any) => d), save: auditSave },
  Role: { findOne: jest.fn(async () => null) },
};

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: (e: any) => repos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null) },
  })),
}));
jest.mock('../../../src/config/mongoose', () => ({ connectMongo: jest.fn() }));
jest.mock('../../../src/schemas/FeatureFlag', () => ({ FeatureFlagModel: { findOneAndUpdate: jest.fn() } }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import configRouter from '../../../src/routes/config';
import { clearPermissionCache } from '../../../src/middleware/auth';

const JWT_SECRET = 'config-test-jwt-secret-0123456789abcdef';
const sign = (id: string) => jwt.sign({ id }, JWT_SECRET, { expiresIn: '1h' });

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = MASTER_KEY;
  secrets = [
    { projectId: PROJ_A, key: 'DB_PASSWORD', encryptedValue: encryptValue('hunter2', MASTER_KEY), environmentId: ENV_PROD, isActive: true },
    { projectId: PROJ_A, key: 'API_KEY', encryptedValue: encryptValue('k-123', MASTER_KEY), environmentId: null, isActive: true },
    { projectId: PROJ_B, key: 'B_SECRET', encryptedValue: encryptValue('b-secret', MASTER_KEY), environmentId: null, isActive: true },
  ];
  app = express();
  app.use(express.json());
  app.use('/api', configRouter);
});
beforeEach(() => {
  clearPermissionCache();
  auditSave.mockClear();
});

describe('GET /api/config (H4)', () => {
  it('400 when projectId is missing (would otherwise return every project)', async () => {
    const r = await request(app).get('/api/config').set('Authorization', `Bearer ${sign('uid-devops')}`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('b-plain');
    expect(JSON.stringify(r.body)).not.toContain('b-secret');
  });

  it('403 for a user who is not a member of the project', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_B}`).set('Authorization', `Bearer ${sign('uid-dev')}`);
    expect(r.status).toBe(403);
  });

  it('members without secrets.reveal get secrets masked', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', `Bearer ${sign('uid-view')}`);
    expect(r.status).toBe(200);
    expect(r.body.PLAIN).toBe('a-plain');
    expect(r.body.API_KEY).toBe('***');
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('callers with secrets.reveal get decrypted values and the reveal is audited', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', `Bearer ${sign('uid-devops')}`);
    expect(r.status).toBe(200);
    expect(r.body.API_KEY).toBe('k-123');
    expect(r.body).not.toHaveProperty('B_SECRET');
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSave).toHaveBeenCalledWith(expect.objectContaining({ action: 'secrets.reveal', targetId: PROJ_A }));
  });

  it('honours environmentId for configs and secrets', async () => {
    const r = await request(app)
      .get(`/api/config?projectId=${PROJ_A}&environmentId=${ENV_DEV}`)
      .set('Authorization', `Bearer ${sign('uid-devops')}`);
    expect(r.status).toBe(200);
    expect(r.body.DEV_ONLY).toBe('dev');
    expect(r.body).not.toHaveProperty('PROD_ONLY');
    expect(r.body).not.toHaveProperty('DB_PASSWORD');
    expect(r.body.API_KEY).toBe('k-123');
  });
});
