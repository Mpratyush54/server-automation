/**
 * SDK token kinds: `server` tokens keep full SDK access; `browser` tokens (shipped in public
 * frontend JS) may only call the routes opted in with allowBrowserSdkToken.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(), loadFromDefault: jest.fn(), makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(), AppsV1Api: jest.fn(), NetworkingV1Api: jest.fn(), CustomObjectsApi: jest.fn(),
}));
jest.mock('../../../src/lib/telemetry-processors', () => ({
  processLogs: jest.fn(async () => {}),
  processApiMetrics: jest.fn(async () => {}),
  processTelemetryEvent: jest.fn(async () => {}),
}));
jest.mock('../../../src/config/mongoose', () => ({ connectMongo: jest.fn(async () => true) }));
jest.mock('../../../src/schemas/BugReport', () => ({ BugReportModel: { create: jest.fn(async () => ({ _id: 'bug-1' })) } }));
const mockResolveDb = jest.fn(async () => ({ postgres: { status: 'error', error: 'x' } }));
jest.mock('../../../src/lib/project-db-ensure', () => ({ resolveProjectDbCredentials: mockResolveDb }));

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SERVER = 'sdk_live_servertoken000000000000000000000';
const BROWSER = 'sdk_live_browsertoken00000000000000000000';
const LEGACY = 'sdk_live_legacytoken000000000000000000000'; // row from before the kind column
const ODD = 'sdk_live_oddkindtoken00000000000000000000'; // unexpected stored kind

const creds: Record<string, any> = {
  [SERVER]: { id: 's', token: SERVER, projectId: PROJ, status: 'active', kind: 'server' },
  [BROWSER]: { id: 'b', token: BROWSER, projectId: PROJ, status: 'active', kind: 'browser' },
  [LEGACY]: { id: 'l', token: LEGACY, projectId: PROJ, status: 'active' },
  [ODD]: { id: 'o', token: ODD, projectId: PROJ, status: 'active', kind: 'superuser' },
};
const SECRET_VALUE = 'super-secret-db-password';
const repos: Record<string, any> = {
  SdkCredential: {
    findOne: jest.fn(async ({ where }: any) => {
      const c = creds[where.token];
      return c && where.status === c.status ? { ...c } : null;
    }),
  },
  Project: { findOne: jest.fn(async ({ where }: any) => (where.id === PROJ ? { id: PROJ, name: 'demo' } : null)) },
  ProjectConfig: { find: jest.fn(async () => [{ key: 'PUBLIC_FLAG', value: 'on', environmentId: null, isSecret: false }]) },
  Secret: { find: jest.fn(async () => [{ key: 'DB_PASSWORD', encryptedValue: 'enc', environmentId: null, isActive: true }]) },
  Environment: { findOne: jest.fn(async () => null) },
  ServiceRegistration: { findOne: jest.fn(async () => null), save: jest.fn(async (r: any) => r) },
};
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: (e: any) => repos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null) },
  })),
}));
jest.mock('../../../src/lib/secrets-encryption', () => ({ decryptValue: jest.fn(() => SECRET_VALUE) }));

import express from 'express';
import request from 'supertest';
import sdkRouter from '../../../src/routes/sdk';
import { allowBrowserSdkToken, sdkOrUserAuthenticate, sdkTokenAuth, AuthenticatedRequest } from '../../../src/middleware/auth';
import { setRedisClientForTests } from '../../../src/lib/redis';
import { setIngestSigningKeyForTests } from '../../../src/lib/telemetry-tokens';
import { normalizeSdkTokenKind } from '../../../src/entities/SdkCredential';

let app: express.Express;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(() => {
  process.env.SECRETS_ENCRYPTION_KEY = 'k'.repeat(64);
  setIngestSigningKeyForTests('t'.repeat(64));
  setRedisClientForTests(null);
  app = express();
  app.use(express.json());
  app.use('/api', sdkRouter);
  // Routes outside routes/sdk.ts that accept SDK tokens are server-only by default too.
  app.post('/api/probe/default', sdkOrUserAuthenticate, (req, res) => res.json({ kind: (req as AuthenticatedRequest).sdkTokenKind }));
  app.post('/api/probe/opted-in', allowBrowserSdkToken, sdkTokenAuth, (req, res) => res.json({ kind: (req as AuthenticatedRequest).sdkTokenKind }));
});
afterAll(() => {
  delete process.env.SECRETS_ENCRYPTION_KEY;
});

type Call = { name: string; method: 'get' | 'post'; path: string; body?: Record<string, unknown>; browser: 'allowed' | 'denied' };
const CALLS: Call[] = [
  { name: 'bug report', method: 'post', path: '/api/sdk/bug-report', body: { projectId: PROJ, description: 'broken' }, browser: 'allowed' },
  { name: 'API metrics', method: 'post', path: '/api/sdk/api-metrics', body: { projectId: PROJ, metrics: [{ route: '/x', durationMs: 3 }] }, browser: 'allowed' },
  { name: 'logs', method: 'post', path: '/api/sdk/logs', body: { logs: [{ message: 'hi' }] }, browser: 'allowed' },
  { name: 'logs ingest alias', method: 'post', path: '/api/logs/ingest', body: { logs: [{ message: 'hi' }] }, browser: 'allowed' },
  { name: 'config', method: 'get', path: `/api/sdk/config?projectId=${PROJ}`, browser: 'denied' },
  { name: 'db credentials', method: 'get', path: `/api/sdk/db-credentials?projectId=${PROJ}`, browser: 'denied' },
  { name: 'register', method: 'post', path: '/api/sdk/register', body: { projectName: 'demo', environmentName: 'development' }, browser: 'denied' },
  { name: 'deregister', method: 'post', path: '/api/sdk/deregister', body: { serviceName: 'api' }, browser: 'denied' },
  { name: 'heartbeat', method: 'post', path: '/api/sdk/heartbeat', body: { cpuPct: 1 }, browser: 'denied' },
  { name: 'non-sdk route (default)', method: 'post', path: '/api/probe/default', body: {}, browser: 'denied' },
  { name: 'opted-in route', method: 'post', path: '/api/probe/opted-in', body: {}, browser: 'allowed' },
];

function send(call: Call, token: string) {
  const r = request(app)[call.method](call.path).set(bearer(token));
  return call.method === 'post' ? r.send(call.body || {}) : r;
}

describe('browser SDK tokens', () => {
  it.each(CALLS.filter((c) => c.browser === 'denied'))('are refused with 403 on $name', async (call) => {
    const r = await send(call, BROWSER);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/browser SDK token/i);
    expect(JSON.stringify(r.body)).not.toContain(SECRET_VALUE);
  });

  it.each(CALLS.filter((c) => c.browser === 'allowed'))('are accepted on $name', async (call) => {
    const r = await send(call, BROWSER);
    expect(r.status).toBeLessThan(300);
  });

  it('never receive config values or decrypted secrets from /sdk/config', async () => {
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(bearer(BROWSER));
    expect(r.status).toBe(403);
    expect(r.body).not.toHaveProperty('DB_PASSWORD');
    expect(r.body).not.toHaveProperty('PUBLIC_FLAG');
    expect(r.body).not.toHaveProperty('telemetry');
    expect(JSON.stringify(r.body)).not.toContain(SECRET_VALUE);
  });

  it('cannot reach database credentials', async () => {
    mockResolveDb.mockClear();
    await request(app).get(`/api/sdk/db-credentials?projectId=${PROJ}`).set(bearer(BROWSER));
    expect(mockResolveDb).not.toHaveBeenCalled();
  });

  it('still cannot write to another project on allowed routes', async () => {
    const r = await request(app).post('/api/sdk/bug-report').set(bearer(BROWSER))
      .send({ projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', description: 'x' });
    expect(r.status).toBe(403);
  });
});

describe('server SDK tokens (existing behaviour)', () => {
  it.each(CALLS.filter((c) => !c.path.startsWith('/api/sdk/register')))('pass authentication on $name', async (call) => {
    const r = await send(call, SERVER);
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it('pass authentication on register', async () => {
    const r = await send(CALLS.find((c) => c.name === 'register')!, SERVER);
    expect([401, 403]).not.toContain(r.status);
  });

  it('receive config values, decrypted secrets and the telemetry block from /sdk/config', async () => {
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(bearer(SERVER));
    expect(r.status).toBe(200);
    expect(r.body.PUBLIC_FLAG).toBe('on');
    expect(r.body.DB_PASSWORD).toBe(SECRET_VALUE);
    expect(r.body.telemetry).toEqual(expect.objectContaining({ enabled: expect.any(Boolean) }));
  });

  it('created before token kinds existed are treated as server tokens', async () => {
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(bearer(LEGACY));
    expect(r.status).toBe(200);
    expect(r.body.DB_PASSWORD).toBe(SECRET_VALUE);
    const p = await request(app).post('/api/probe/default').set(bearer(LEGACY)).send({});
    expect(p.body.kind).toBe('server');
  });
});

describe('unexpected stored kinds', () => {
  it('fall back to the least-privileged browser kind', async () => {
    expect(normalizeSdkTokenKind('superuser')).toBe('browser');
    expect(normalizeSdkTokenKind(undefined)).toBe('server');
    expect(normalizeSdkTokenKind(null)).toBe('server');
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(bearer(ODD));
    expect(r.status).toBe(403);
  });
});
