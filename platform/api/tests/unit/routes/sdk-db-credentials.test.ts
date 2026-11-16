/**
 * C2 regression — /sdk/db-credentials is bound to the token's project and never
 * returns the platform's own database credentials (project-db-ensure fallback).
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(), loadFromDefault: jest.fn(), makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(), AppsV1Api: jest.fn(), NetworkingV1Api: jest.fn(), CustomObjectsApi: jest.fn(),
}));

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'sdk_live_dbcredstoken000000000000000000';

const mockResolve = jest.fn();
jest.mock('../../../src/lib/project-db-ensure', () => ({
  resolveProjectDbCredentials: (...a: any[]) => mockResolve(...a),
  ensureProjectDatabases: jest.fn(),
}));

const repos: Record<string, any> = {
  SdkCredential: {
    findOne: jest.fn(async ({ where }: any) =>
      where.token === TOKEN && where.status === 'active' ? { id: 'c', token: TOKEN, projectId: PROJ, status: 'active' } : null),
  },
  Project: { findOne: jest.fn(async ({ where }: any) => (where.id === PROJ ? { id: PROJ, name: 'demo' } : null)) },
  ProjectConfig: { find: jest.fn(async () => []) },
  Secret: { find: jest.fn(async () => mockSecrets) },
  Environment: { findOne: jest.fn(async () => null) },
};
let mockSecrets: any[] = [];
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: (e: any) => repos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null) },
  })),
}));

import express from 'express';
import request from 'supertest';
import sdkRouter from '../../../src/routes/sdk';
import { encryptValue } from '../../../src/lib/secrets-encryption';

let app: express.Express;
beforeAll(() => {
  process.env.POSTGRES_USER = 'plat';
  process.env.POSTGRES_PASSWORD = 'platform-pg-password';
  process.env.POSTGRES_DB = 'plat_platform';
  process.env.MONGODB_URI = 'mongodb://plat:pw@mongo:27017/plat_platform';
  process.env.REDIS_PASSWORD = 'platform-redis-password';
  app = express();
  app.use(express.json());
  app.use('/api', sdkRouter);
});
beforeEach(() => mockResolve.mockReset());

const auth = { Authorization: `Bearer ${TOKEN}` };

it('403 for a foreign project id', async () => {
  const r = await request(app).get('/api/sdk/db-credentials?projectId=other-project').set(auth);
  expect(r.status).toBe(403);
  expect(mockResolve).not.toHaveBeenCalled();
});

it('refuses platform-owned postgres / mongo / unprefixed redis credentials', async () => {
  mockResolve.mockResolvedValue({
    postgres: { host: 'pg', user: 'plat', password: 'platform-pg-password', database: 'plat_platform' },
    mongo: { uri: 'mongodb://plat:pw@mongo:27017/plat_platform' },
    redis: { host: 'redis', password: 'r' },
  });
  const r = await request(app).get('/api/sdk/db-credentials?projectId=demo').set(auth);
  expect(r.status).toBe(200);
  expect(r.body.postgres.status).toBe('error');
  expect(r.body.mongo.status).toBe('error');
  expect(r.body.redis.status).toBe('error');
  expect(JSON.stringify(r.body)).not.toContain('platform-pg-password');
});

it('refuses redis credentials that reuse the platform Redis password, even with a key prefix', async () => {
  mockResolve.mockResolvedValue({ redis: { host: 'redis', password: 'platform-redis-password', keyPrefix: 'plat:demo:dev:' } });
  const r = await request(app).get('/api/sdk/db-credentials?projectId=demo&dbTypes=redis').set(auth);
  expect(r.status).toBe(200);
  expect(r.body.redis.status).toBe('error');
  expect(JSON.stringify(r.body)).not.toContain('platform-redis-password');
  expect(mockResolve).toHaveBeenCalledWith(PROJ, 'demo', expect.any(String), expect.any(Array));
});

it('passes through project-scoped credentials', async () => {
  mockResolve.mockResolvedValue({
    postgres: { host: 'pg', user: 'plat_demo_development_user', password: 'p', database: 'plat_demo_development' },
    mongo: { uri: 'mongodb://plat_demo_user:p@mongo:27017/plat_demo_development?authSource=plat_demo_development' },
    redis: { host: 'redis', username: 'plat_demo_development', password: 'r', keyPrefix: 'demo:development:' },
  });
  const r = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}`).set(auth);
  expect(r.status).toBe(200);
  expect(r.body.postgres.user).toBe('plat_demo_development_user');
  expect(r.body.mongo.uri).toContain('plat_demo_development');
  expect(r.body.redis.keyPrefix).toBe('demo:development:');
  expect(r.body.redis.username).toBe('plat_demo_development');
});

it('passes multi-host replica-set mongo URIs and refuses the platform multi-host URI', async () => {
  const prev = process.env.MONGODB_URI;
  process.env.MONGODB_URI = 'mongodb://root:pw@mongo-0:27017,mongo-1:27017/plat_platform?replicaSet=rs0&authSource=admin';
  try {
    mockResolve.mockResolvedValue({
      mongo: { uri: 'mongodb://plat_demo_user:p@mongo-0:27017,mongo-1:27017/plat_demo_development?replicaSet=rs0&authSource=plat_demo_development' },
    });
    const ok = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}&dbTypes=mongo`).set(auth);
    expect(ok.status).toBe(200);
    expect(ok.body.mongo.uri).toContain('mongo-0:27017,mongo-1:27017');
    expect(ok.body.mongo.uri).toContain('replicaSet=rs0');
    expect(ok.body.mongo.status).toBeUndefined();

    mockResolve.mockResolvedValue({
      mongo: { uri: 'mongodb://root:pw@mongo-0:27017,mongo-1:27017/plat_platform?replicaSet=rs0&authSource=admin' },
    });
    const bad = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}&dbTypes=mongo`).set(auth);
    expect(bad.status).toBe(200);
    expect(bad.body.mongo.status).toBe('error');
    expect(JSON.stringify(bad.body)).not.toContain('root:pw');
  } finally {
    process.env.MONGODB_URI = prev;
  }
});

it('refuses redis sentinel credentials that reuse the platform password or default user', async () => {
  mockResolve.mockResolvedValue({
    redis: {
      host: 'redis', username: 'plat_demo_development', password: 'project-pw', keyPrefix: 'demo:development:',
      sentinels: [{ host: 's0', port: 26379 }], masterName: 'mymaster',
      sentinelUsername: 'default', sentinelPassword: 'x',
    },
  });
  const r1 = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}&dbTypes=redis`).set(auth);
  expect(r1.body.redis.status).toBe('error');

  mockResolve.mockResolvedValue({
    redis: {
      host: 'redis', username: 'plat_demo_development', password: 'project-pw', keyPrefix: 'demo:development:',
      sentinels: [{ host: 's0', port: 26379 }], masterName: 'mymaster',
      sentinelUsername: 'plat-sentinel', sentinelPassword: 'platform-redis-password',
    },
  });
  const r2 = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}&dbTypes=redis`).set(auth);
  expect(r2.body.redis.status).toBe('error');
});

it('refuses mongo URIs with the platform user and redis credentials without an ACL user', async () => {
  mockResolve.mockResolvedValue({
    mongo: { uri: 'mongodb://plat:pw@mongo:27017/plat_demo_development' },
    redis: { host: 'redis', password: 'r', keyPrefix: 'demo:development:' },
  });
  const r = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}&dbTypes=mongo,redis`).set(auth);
  expect(r.status).toBe(200);
  expect(r.body.mongo.status).toBe('error');
  expect(r.body.redis.status).toBe('error');
  expect(JSON.stringify(r.body)).not.toContain('plat:pw');
});

it('passes per-type provisioning errors through unchanged', async () => {
  mockResolve.mockResolvedValue({
    postgres: { host: 'pg', user: 'plat_demo_development_user', password: 'p', database: 'plat_demo_development' },
    redis: { status: 'error', error: 'Redis provisioning failed' },
  });
  const r = await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}&dbTypes=postgres,redis`).set(auth);
  expect(r.status).toBe(200);
  expect(r.body.postgres.user).toBe('plat_demo_development_user');
  expect(r.body.redis).toEqual({ status: 'error', error: 'Redis provisioning failed' });
});

it('/sdk/config never serves platform-owned secret values copied into the project', async () => {
  const key = 'c'.repeat(64);
  process.env.SECRETS_ENCRYPTION_KEY = key;
  mockSecrets = [
    { projectId: PROJ, key: 'REDIS_PASSWORD', encryptedValue: encryptValue('platform-redis-password', key), environmentId: null, isActive: true },
    { projectId: PROJ, key: 'APP_SECRET', encryptedValue: encryptValue('project-value', key), environmentId: null, isActive: true },
  ];
  const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(auth);
  expect(r.status).toBe(200);
  expect(r.body.APP_SECRET).toBe('project-value');
  expect(r.body).not.toHaveProperty('REDIS_PASSWORD');
  const foreign = await request(app).get('/api/sdk/config?projectId=another').set(auth);
  expect(foreign.status).toBe(403);
});
