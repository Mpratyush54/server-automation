/**
 * #49: the telemetry block of GET /sdk/config, and SDK ingest endpoints enqueueing to the
 * Redis stream (202) with backpressure (429 + Retry-After).
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(), loadFromDefault: jest.fn(), makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(), AppsV1Api: jest.fn(), NetworkingV1Api: jest.fn(), CustomObjectsApi: jest.fn(),
}));

const mockProcessEvent = jest.fn(async (_kind: string, _payload: any) => {});
jest.mock('../../../src/lib/telemetry-processors', () => ({
  processLogs: jest.fn(async () => {}),
  processApiMetrics: jest.fn(async () => {}),
  processTelemetryEvent: (k: string, p: any) => mockProcessEvent(k, p),
}));

const PROJ = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENV_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TOKEN = 'sdk_live_telemetrytoken0000000000000000';

const mockConfigs: any[] = [];
const repos: Record<string, any> = {
  SdkCredential: {
    findOne: jest.fn(async ({ where }: any) =>
      where.token === TOKEN && where.status === 'active' ? { id: 'c', token: TOKEN, projectId: PROJ, status: 'active' } : null),
  },
  Project: { findOne: jest.fn(async ({ where }: any) => (where.id === PROJ ? { id: PROJ, name: 'demo', domain: 'demo.example.org' } : null)) },
  ProjectConfig: { find: jest.fn(async () => mockConfigs) },
  Secret: { find: jest.fn(async () => []) },
  Environment: {
    findOne: jest.fn(async ({ where }: any) => {
      const env = { id: ENV_ID, name: 'staging', projectId: PROJ, domain: 'demo-staging.example.org' };
      return (where.id === ENV_ID || where.name === 'staging') && where.projectId === PROJ ? env : null;
    }),
  },
};
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => ({
    getRepository: (e: any) => repos[typeof e === 'string' ? e : e.name] || { findOne: jest.fn(async () => null) },
  })),
}));

import express from 'express';
import request from 'supertest';
import type Redis from 'ioredis';
import sdkRouter from '../../../src/routes/sdk';
import { setRedisClientForTests } from '../../../src/lib/redis';
import { setIngestSigningKeyForTests, verifyIngestToken } from '../../../src/lib/telemetry-tokens';
import { resetTelemetryCountersForTests } from '../../../src/lib/telemetry-queue';
import { FakeStreamRedis } from '../../helpers/fake-stream-redis';

let app: express.Express;
const auth = { Authorization: `Bearer ${TOKEN}` };

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api', sdkRouter);
});
beforeEach(() => {
  setIngestSigningKeyForTests('t'.repeat(64));
  mockConfigs.length = 0;
  mockProcessEvent.mockReset().mockResolvedValue(undefined);
  resetTelemetryCountersForTests();
  for (const k of ['PLATFORM_OBSERVABILITY', 'TELEMETRY_COLLECTOR_URL', 'OTEL_COLLECTOR_HOST', 'DOMAIN', 'TELEMETRY_SAMPLING_RATIO', 'TELEMETRY_QUEUE_MAX_BACKLOG']) {
    delete process.env[k];
  }
});
afterEach(() => setRedisClientForTests(null));

describe('GET /sdk/config telemetry block', () => {
  it('is disabled with null endpoints and tokens when the observability backend is not installed', async () => {
    process.env.DOMAIN = 'platform.example.org';
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}&environmentId=staging`).set(auth);
    expect(r.status).toBe(200);
    expect(r.body.telemetry).toEqual({
      enabled: false,
      otlpEndpoint: null,
      faroEndpoint: null,
      profilesEndpoint: null,
      ingestToken: null,
      ingestTokenExpiresAt: null,
      browserToken: null,
      samplingRatio: 1,
      resource: { 'platform.project_id': PROJ, 'deployment.environment': 'staging' },
    });
  });

  it('returns collector endpoints and verifiable ingest tokens when enabled', async () => {
    process.env.PLATFORM_OBSERVABILITY = 'enabled';
    process.env.DOMAIN = 'platform.example.org';
    process.env.TELEMETRY_SAMPLING_RATIO = '0.25';
    mockConfigs.push({ key: 'TELEMETRY_ALLOWED_ORIGINS', value: 'https://shop.example.net, http://localhost:4200', environmentId: null, isSecret: false });
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}&environmentId=${ENV_ID}`).set(auth);
    expect(r.status).toBe(200);
    const t = r.body.telemetry;
    expect(t).toMatchObject({
      enabled: true,
      otlpEndpoint: 'https://otel.platform.example.org',
      faroEndpoint: 'https://otel.platform.example.org/collect',
      profilesEndpoint: 'https://otel.platform.example.org/pyroscope',
      samplingRatio: 0.25,
      resource: { 'platform.project_id': PROJ, 'deployment.environment': 'staging' },
    });
    expect(t.ingestToken).toMatch(/^plat_ingest_(?!web_)/);
    expect(t.browserToken).toMatch(/^plat_ingest_web_/);
    // Session replay (#40) is part of the full profile: the browser SDK posts chunks here.
    expect(t.replayEndpoint).toBe('https://platform.example.org/api/sdk/replay');
    expect(new Date(t.ingestTokenExpiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);

    const server = await verifyIngestToken(t.ingestToken);
    expect(server.ok && server.claims).toMatchObject({ typ: 'server', projectId: PROJ, environment: 'staging' });
    const web = await verifyIngestToken(t.browserToken);
    expect(web.ok && web.claims.origins).toEqual([
      'http://localhost:4200', 'https://demo-staging.example.org', 'https://demo.example.org', 'https://shop.example.net',
    ]);
    // Existing config keys are still served unchanged next to the block.
    expect(r.body.TELEMETRY_ALLOWED_ORIGINS).toBe('https://shop.example.net, http://localhost:4200');
  });

  it('honours TELEMETRY_COLLECTOR_URL / OTEL_COLLECTOR_HOST', async () => {
    process.env.PLATFORM_OBSERVABILITY = 'true';
    process.env.OTEL_COLLECTOR_HOST = 'collector.example.org';
    let r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(auth);
    expect(r.body.telemetry.otlpEndpoint).toBe('https://collector.example.org');
    expect(r.body.telemetry.resource['deployment.environment']).toBe('development');
    process.env.TELEMETRY_COLLECTOR_URL = 'https://otel.example.org/';
    r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(auth);
    expect(r.body.telemetry.faroEndpoint).toBe('https://otel.example.org/collect');
  });

  it('stays disabled when enabled but no collector host can be derived', async () => {
    process.env.PLATFORM_OBSERVABILITY = 'enabled';
    const r = await request(app).get(`/api/sdk/config?projectId=${PROJ}`).set(auth);
    expect(r.body.telemetry.enabled).toBe(false);
  });
});

describe('ingest endpoints with the Redis queue', () => {
  let fake: FakeStreamRedis;
  beforeEach(() => {
    fake = new FakeStreamRedis();
    setRedisClientForTests(fake as unknown as Redis);
  });

  it('POST /sdk/logs enqueues and answers 202 without touching the destinations', async () => {
    const r = await request(app).post('/api/sdk/logs').set(auth).send({ logs: [{ level: 'warn', message: 'm', projectId: 'demo' }] });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ received: 1, queued: true });
    expect(fake.entries).toHaveLength(1);
    const f = fake.entries[0].fields;
    const doc = JSON.parse(f[f.indexOf('d') + 1])[0];
    expect(doc).toMatchObject({ projectId: PROJ, level: 'WARN', message: 'm' }); // bound to the token's project
    expect(mockProcessEvent).not.toHaveBeenCalled();
  });

  it('POST /logs/ingest, /sdk/api-metrics and /sdk/heartbeat enqueue too', async () => {
    expect((await request(app).post('/api/logs/ingest').set(auth).send({ logs: [{ message: 'x' }] })).status).toBe(202);
    const m = await request(app).post('/api/sdk/api-metrics').set(auth).send({ projectId: PROJ, metrics: [{ route: '/a', durationMs: 3 }] });
    expect(m.status).toBe(202);
    expect(m.body).toEqual({ accepted: 1, queued: true });
    const h = await request(app).post('/api/sdk/heartbeat').set(auth).send({ projectId: PROJ, cpuPct: 4, junk: 'x'.repeat(10) });
    expect(h.status).toBe(202);
    expect(fake.entries.map((e) => e.fields[1])).toEqual(['logs', 'api-metrics', 'heartbeat']);
    const hb = JSON.parse(fake.entries[2].fields[fake.entries[2].fields.indexOf('d') + 1]);
    expect(hb).toMatchObject({ projectId: PROJ, body: { cpuPct: 4 } });
    expect(hb.body.junk).toBeUndefined();
  });

  it('validation and project binding still happen synchronously', async () => {
    expect((await request(app).post('/api/sdk/logs').set(auth).send({ logs: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/sdk/logs').set(auth).send({ logs: [{ level: 'INFO' }] })).status).toBe(400);
    expect((await request(app).post('/api/sdk/logs').set(auth).send({ logs: [{ message: 'x', projectId: 'other' }] })).status).toBe(403);
    expect((await request(app).post('/api/sdk/logs').send({ logs: [{ message: 'x' }] })).status).toBe(401);
    expect(fake.entries).toHaveLength(0);
  });

  it('429 with Retry-After when the backlog exceeds the threshold', async () => {
    process.env.TELEMETRY_QUEUE_MAX_BACKLOG = '2';
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post('/api/sdk/logs').set(auth).send({ logs: [{ message: String(i) }] })).status).toBe(202);
    }
    const r = await request(app).post('/api/sdk/logs').set(auth).send({ logs: [{ message: 'over' }] });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('5');
    const hb = await request(app).post('/api/sdk/heartbeat').set(auth).send({ projectId: PROJ });
    expect(hb.status).toBe(429);
    expect(fake.entries).toHaveLength(2);
  });

  it('without Redis (memory mode) the payload is processed inline with the historical status', async () => {
    setRedisClientForTests(null);
    const r = await request(app).post('/api/sdk/logs').set(auth).send({ logs: [{ message: 'inline' }] });
    expect(r.status).toBe(201);
    expect(mockProcessEvent).toHaveBeenCalledWith('logs', [expect.objectContaining({ message: 'inline', projectId: PROJ })]);
    const h = await request(app).post('/api/sdk/heartbeat').set(auth).send({ projectId: PROJ });
    expect(h.status).toBe(200);
  });
});
