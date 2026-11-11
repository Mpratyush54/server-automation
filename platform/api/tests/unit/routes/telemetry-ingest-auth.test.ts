/**
 * GET /api/telemetry/ingest-auth — ingress-nginx external auth for the collector (#49).
 */
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: () => ({ findOne: jest.fn(async () => null) }) })),
}));

import express from 'express';
import request from 'supertest';
import { issueIngestToken, setIngestSigningKeyForTests } from '../../../src/lib/telemetry-tokens';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL_ = '/api/telemetry/ingest-auth';

let app: express.Express;
beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-ingest-auth-0000000000';
  process.env.TELEMETRY_INGEST_AUTH_RATE_LIMIT = '5';
  process.env.TELEMETRY_INGEST_AUTH_WEB_RATE_LIMIT = '3';
  setIngestSigningKeyForTests('s'.repeat(64));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const telemetryRouter = require('../../../src/routes/telemetry').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { expressAuthenticate, sdkTokenAuth } = require('../../../src/middleware/auth');
  app = express();
  app.use(express.json());
  app.use('/api', telemetryRouter);
  app.get('/api/protected', expressAuthenticate, (_req, res) => res.json({ ok: true }));
  app.get('/api/sdk-only', sdkTokenAuth, (_req, res) => res.json({ ok: true }));
});

const server = (env = 'production') => issueIngestToken({ projectId: PID, environment: env, type: 'server' });
const web = (origins = ['https://shop.example.org']) => issueIngestToken({ projectId: PID, environment: 'production', type: 'web', origins });

it('200 with project/environment headers for a valid server token on an OTLP path', async () => {
  const { token } = await server();
  const r = await request(app).get(URL_).set('Authorization', `Bearer ${token}`).set('X-Original-URL', 'https://otel.example.org/v1/traces');
  expect(r.status).toBe(200);
  expect(r.headers['x-platform-project-id']).toBe(PID);
  expect(r.headers['x-platform-environment']).toBe('production');
  expect(r.headers['cache-control']).toMatch(/max-age=60/);
});

it('accepts the original method (POST) and a direct call without X-Original-URL', async () => {
  const { token } = await server('staging');
  const r = await request(app).post(URL_).set('Authorization', `Bearer ${token}`);
  expect(r.status).toBe(200);
  expect(r.headers['x-platform-environment']).toBe('staging');
});

it('401 without a token, with a garbage token, with an SDK credential or a forged token', async () => {
  const { token } = await server();
  const i = token.length - 20; // inside the signature
  const forged = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
  for (const auth of [undefined, 'Bearer nope', 'Bearer sdk_live_000000000000000000000', `Bearer ${forged}`, `Basic ${token}`]) {
    const req = request(app).get(URL_);
    const r = await (auth ? req.set('Authorization', auth) : req);
    expect(r.status).toBe(401);
    expect(r.headers['x-platform-project-id']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('no-store');
  }
});

it('401 for an expired token', async () => {
  const { token } = await issueIngestToken({ projectId: PID, environment: 'production', type: 'server', ttlSeconds: 600, now: Date.now() - 3600_000 });
  const r = await request(app).get(URL_).set('Authorization', `Bearer ${token}`);
  expect(r.status).toBe(401);
  expect(r.body.reason).toBe('expired');
});

it('401 wrong scope: server token on the Faro path, browser token on OTLP, unknown paths', async () => {
  const s = (await server()).token;
  const w = (await web()).token;
  const cases: [string, string][] = [[s, '/collect'], [w, '/v1/traces'], [w, '/pyroscope/ingest'], [s, '/admin']];
  for (const [token, path] of cases) {
    const r = await request(app).get(URL_).set('Authorization', `Bearer ${token}`)
      .set('X-Original-URL', `https://otel.example.org${path}`).set('Origin', 'https://shop.example.org');
    expect(r.status).toBe(401);
    expect(r.body.reason).toBe('wrong_scope');
  }
});

it('browser tokens: only from an allowed Origin', async () => {
  const { token } = await web(['https://shop.example.org', 'https://*.preview.example.org']);
  const call = (origin?: string) => {
    const req = request(app).get(URL_).set('Authorization', `Bearer ${token}`).set('X-Original-URL', 'https://otel.example.org/collect');
    return origin ? req.set('Origin', origin) : req;
  };
  expect((await call('https://shop.example.org')).status).toBe(200);
  expect((await call('https://pr-7.preview.example.org')).status).toBe(200);
  const bad = await call('https://evil.example.net');
  expect(bad.status).toBe(401);
  expect(bad.body.reason).toBe('origin_not_allowed');
  expect((await call()).status).toBe(401);
});

it('lets the credential-less CORS preflight to /collect through', async () => {
  const r = await request(app).get(URL_).set('X-Original-Method', 'OPTIONS').set('X-Original-URL', 'https://otel.example.org/collect');
  expect(r.status).toBe(200);
  expect(r.headers['x-platform-project-id']).toBeUndefined();
  const r2 = await request(app).get(URL_).set('X-Original-Method', 'OPTIONS').set('X-Original-URL', 'https://otel.example.org/v1/traces');
  expect(r2.status).toBe(401);
});

it('rate limits per token (429 + Retry-After), independently for each token', async () => {
  const a = (await issueIngestToken({ projectId: PID, environment: 'ratelimit-a', type: 'server' })).token;
  const b = (await issueIngestToken({ projectId: PID, environment: 'ratelimit-b', type: 'server' })).token;
  for (let i = 0; i < 5; i++) expect((await request(app).get(URL_).set('Authorization', `Bearer ${a}`)).status).toBe(200);
  const limited = await request(app).get(URL_).set('Authorization', `Bearer ${a}`);
  expect(limited.status).toBe(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect((await request(app).get(URL_).set('Authorization', `Bearer ${b}`)).status).toBe(200);
});

it('browser tokens have their own (lower) budget', async () => {
  const { token } = await issueIngestToken({ projectId: PID, environment: 'ratelimit-web', type: 'web', origins: ['https://shop.example.org'] });
  const call = () => request(app).get(URL_).set('Authorization', `Bearer ${token}`).set('Origin', 'https://shop.example.org');
  for (let i = 0; i < 3; i++) expect((await call()).status).toBe(200);
  expect((await call()).status).toBe(429);
});

it('behind the mapping Ingress (?errors=mapped) throttling is a 403 carrying the real status', async () => {
  const { token } = await issueIngestToken({ projectId: PID, environment: 'ratelimit-mapped', type: 'server' });
  const call = () => request(app).get(`${URL_}?errors=mapped`).set('Authorization', `Bearer ${token}`)
    .set('X-Original-URL', 'https://otel.example.org/v1/traces');
  for (let i = 0; i < 5; i++) expect((await call()).status).toBe(200);
  const r = await call();
  expect(r.status).toBe(403);
  expect(r.headers['x-platform-auth-status']).toBe('429');
  expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
  expect(r.headers['x-platform-allowed-origin']).toBeUndefined();
  expect(r.headers['cache-control']).toBe('no-store');
});

it('mapped throttling of a browser token echoes only its verified Origin', async () => {
  const { token } = await issueIngestToken({ projectId: PID, environment: 'ratelimit-web-mapped', type: 'web', origins: ['https://shop.example.org'] });
  const call = (origin: string) => request(app).get(`${URL_}?errors=mapped`).set('Authorization', `Bearer ${token}`)
    .set('X-Original-URL', 'https://otel.example.org/collect').set('Origin', origin);
  for (let i = 0; i < 3; i++) expect((await call('https://shop.example.org')).status).toBe(200);
  const r = await call('https://shop.example.org');
  expect(r.status).toBe(403);
  expect(r.headers['x-platform-auth-status']).toBe('429');
  expect(r.headers['x-platform-allowed-origin']).toBe('https://shop.example.org');
  // A foreign Origin is refused before the limiter: plain 401, nothing echoed.
  const bad = await call('https://evil.example.net');
  expect(bad.status).toBe(401);
  expect(bad.headers['x-platform-auth-status']).toBeUndefined();
  expect(bad.headers['x-platform-allowed-origin']).toBeUndefined();
});

it('auth failures stay 401 in mapped mode (never confused with throttling)', async () => {
  const r = await request(app).get(`${URL_}?errors=mapped`).set('Authorization', 'Bearer nope');
  expect(r.status).toBe(401);
  expect(r.headers['x-platform-auth-status']).toBeUndefined();
});

it('ingest tokens never grant API access', async () => {
  const s = (await server()).token;
  const w = (await web()).token;
  for (const t of [s, w]) {
    expect((await request(app).get('/api/protected').set('Authorization', `Bearer ${t}`)).status).toBe(401);
    expect((await request(app).get('/api/sdk-only').set('Authorization', `Bearer ${t}`)).status).toBe(401);
  }
});

it('503 (not 401) when the signing key cannot be loaded, so clients retry', async () => {
  const { token } = await server();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const tokens = require('../../../src/lib/telemetry-tokens');
  tokens.setIngestKeyStoreForTests({
    description: 'broken', read: async () => { throw new Error('down'); }, patch: async () => {}, createIfAbsent: async () => ({}),
  });
  const r = await request(app).get(URL_).set('Authorization', `Bearer ${token}`);
  expect(r.status).toBe(503);
  expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  const mapped = await request(app).get(`${URL_}?errors=mapped`).set('Authorization', `Bearer ${token}`);
  expect(mapped.status).toBe(403);
  expect(mapped.headers['x-platform-auth-status']).toBe('503');
  tokens.setIngestKeyStoreForTests(undefined);
  setIngestSigningKeyForTests('s'.repeat(64));
});
