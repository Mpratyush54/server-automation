/**
 * H4 regressions — GET /config requires projectId + membership, masks secrets
 * unless the caller holds secrets.reveal AND has a recent MFA step-up (audited),
 * and honours environmentId.
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
let agentTokenRecord: any = null;
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
  AgentToken: {
    findOne: jest.fn(async ({ where }: any) => (agentTokenRecord && where.tokenPrefix === agentTokenRecord.tokenPrefix ? agentTokenRecord : null)),
    save: jest.fn(async (d: any) => d),
  },
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
import bcrypt from 'bcryptjs';
import configRouter from '../../../src/routes/config';
import { AGENT_TOKEN_LOOKUP_LEN, clearPermissionCache } from '../../../src/middleware/auth';

const JWT_SECRET = 'config-test-jwt-secret-0123456789abcdef';
const nowSec = () => Math.floor(Date.now() / 1000);
/** Session without a recent second factor (password only). */
const sign = (id: string) => jwt.sign({ id, amr: ['pwd'], auth_time: nowSec() }, JWT_SECRET, { expiresIn: '1h' });
/** Session with a fresh MFA step-up. */
const signMfa = (id: string, authTime = nowSec()) =>
  jwt.sign({ id, amr: ['pwd', 'otp', 'mfa'], auth_time: authTime }, JWT_SECRET, { expiresIn: '1h' });
const AGENT_RAW = 'plat_agent_' + 'z'.repeat(40);

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = MASTER_KEY;
  secrets = [
    { projectId: PROJ_A, key: 'DB_PASSWORD', encryptedValue: encryptValue('hunter2', MASTER_KEY), environmentId: ENV_PROD, isActive: true },
    { projectId: PROJ_A, key: 'API_KEY', encryptedValue: encryptValue('k-123', MASTER_KEY), environmentId: null, isActive: true },
    { projectId: PROJ_B, key: 'B_SECRET', encryptedValue: encryptValue('b-secret', MASTER_KEY), environmentId: null, isActive: true },
  ];
  agentTokenRecord = {
    id: 'agent-1', name: 'mcp', scopes: ['*'], isActive: true, revokedAt: null, expiresAt: null,
    tokenPrefix: AGENT_RAW.slice(0, AGENT_TOKEN_LOOKUP_LEN), tokenHash: bcrypt.hashSync(AGENT_RAW, 4),
  };
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

  it('secrets.reveal holders without a recent MFA step-up get secrets masked (200, no audit)', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', `Bearer ${sign('uid-devops')}`);
    expect(r.status).toBe(200);
    expect(r.body.PLAIN).toBe('a-plain');
    expect(r.body.API_KEY).toBe('***');
    expect(r.body.DB_PASSWORD).toBe('***');
    expect(JSON.stringify(r.body)).not.toContain('k-123');
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(r.headers['x-secrets-masked']).toBe('step-up-required');
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('a stale MFA step-up is treated as no step-up', async () => {
    const r = await request(app)
      .get(`/api/config?projectId=${PROJ_A}`)
      .set('Authorization', `Bearer ${signMfa('uid-devops', nowSec() - 16 * 60)}`);
    expect(r.status).toBe(200);
    expect(r.body.API_KEY).toBe('***');
    expect(r.headers['x-secrets-masked']).toBe('step-up-required');
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('callers with secrets.reveal and a recent MFA step-up get decrypted values and the reveal is audited', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', `Bearer ${signMfa('uid-devops')}`);
    expect(r.status).toBe(200);
    expect(r.body.PLAIN).toBe('a-plain');
    expect(r.body.API_KEY).toBe('k-123');
    expect(r.body.DB_PASSWORD).toBe('hunter2');
    expect(r.body).not.toHaveProperty('B_SECRET');
    expect(r.headers['x-secrets-masked']).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSave).toHaveBeenCalledTimes(1);
    expect(auditSave).toHaveBeenCalledWith(expect.objectContaining({
      action: 'secrets.reveal',
      targetId: PROJ_A,
      userId: 'uid-devops',
      metadata: expect.objectContaining({ via: 'GET /config', keys: expect.arrayContaining(['API_KEY', 'DB_PASSWORD']) }),
    }));
  });

  it('a recent MFA step-up does not grant reveal to callers without secrets.reveal', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', `Bearer ${signMfa('uid-view')}`);
    expect(r.status).toBe(200);
    expect(r.body.PLAIN).toBe('a-plain');
    expect(r.body.API_KEY).toBe('***');
    expect(r.headers['x-secrets-masked']).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('agent tokens always get secrets masked and nothing is audited', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', `Bearer ${AGENT_RAW}`);
    expect(r.status).toBe(200);
    expect(r.body.PLAIN).toBe('a-plain');
    expect(r.body.API_KEY).toBe('***');
    expect(r.body.DB_PASSWORD).toBe('***');
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditSave).not.toHaveBeenCalled();
  });

  it('SDK credentials are not accepted on GET /config (no secrets leak)', async () => {
    const r = await request(app).get(`/api/config?projectId=${PROJ_A}`).set('Authorization', 'Bearer plat_sdk_not-a-session-token');
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toContain('k-123');
  });

  it('honours environmentId for configs and secrets', async () => {
    const r = await request(app)
      .get(`/api/config?projectId=${PROJ_A}&environmentId=${ENV_DEV}`)
      .set('Authorization', `Bearer ${signMfa('uid-devops')}`);
    expect(r.status).toBe(200);
    expect(r.body.DEV_ONLY).toBe('dev');
    expect(r.body).not.toHaveProperty('PROD_ONLY');
    expect(r.body).not.toHaveProperty('DB_PASSWORD');
    expect(r.body.API_KEY).toBe('k-123');
  });
});
