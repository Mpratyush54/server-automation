/**
 * L1 regressions — helmet headers, CORS allowlist, rate limiting on credential
 * endpoints, raw body capture.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(),
    loadFromDefault: jest.fn(),
    makeApiClient: jest.fn().mockReturnValue({}),
  })),
  CoreV1Api: jest.fn(),
  AppsV1Api: jest.fn(),
  NetworkingV1Api: jest.fn(),
  CustomObjectsApi: jest.fn(),
}));
jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockRejectedValue(new Error('no db in unit tests')),
}));

import request from 'supertest';
import express from 'express';

process.env.JWT_SECRET = 'server-test-jwt-secret-0123456789abcdef';
process.env.CORS_ORIGINS = 'https://portal.example.com';
process.env.AUTH_RATE_LIMIT_MAX = '3';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildApp, jsonBodyParser, requestLogger, redactUrlForLog } = require('../../src/server');

describe('buildApp security middleware', () => {
  let app: express.Express;
  beforeAll(() => { app = buildApp(); });

  it('sets helmet security headers', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS only for allowlisted origins on human endpoints', async () => {
    const ok = await request(app).get('/api/health').set('Origin', 'https://portal.example.com');
    expect(ok.headers['access-control-allow-origin']).toBe('https://portal.example.com');
    const local = await request(app).get('/api/health').set('Origin', 'http://localhost:4200');
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example.net');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reflects any origin (without credentials) on SDK ingest endpoints', async () => {
    const r = await request(app).options('/api/sdk/logs')
      .set('Origin', 'https://customer-app.example.org')
      .set('Access-Control-Request-Method', 'POST');
    expect(r.headers['access-control-allow-origin']).toBe('https://customer-app.example.org');
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rate-limits the login endpoint', async () => {
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/login').send({ email: 'x@y.io', password: 'nope' });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it('captures the raw JSON body on req.rawBody (byte-exact, for webhook HMACs)', async () => {
    let raw: Buffer | undefined;
    let parsed: any;
    const probe = express();
    probe.use(jsonBodyParser);
    probe.post('/x', (req, res) => { raw = (req as any).rawBody; parsed = req.body; res.json({ ok: true }); });
    const payload = '{ "a" : 1,"b":[2] }';
    await request(probe).post('/x').set('Content-Type', 'application/json').send(payload);
    expect(raw?.toString()).toBe(payload);
    expect(parsed).toEqual({ a: 1, b: [2] });
  });

  it('never writes query-string values (OAuth code/state, tokens) to the access log', async () => {
    const lines: string[] = [];
    const probe = express();
    probe.use(requestLogger({ stream: { write: (l: string) => { lines.push(l); } } }));
    probe.get('/api/auth/github/callback', (_req, res) => res.json({ ok: true }));
    await request(probe).get('/api/auth/github/callback?code=oauth-code-123&state=state-456&token=jwt-789');
    const log = lines.join('');
    expect(log).toContain('/api/auth/github/callback?code=[REDACTED]&state=[REDACTED]&token=[REDACTED]');
    expect(log).not.toMatch(/oauth-code-123|state-456|jwt-789/);
  });

  it('does not log successful health checks but logs failing ones and other routes', async () => {
    const lines: string[] = [];
    const probe = express();
    probe.use(requestLogger({ stream: { write: (l: string) => { lines.push(l); } } }));
    probe.get('/api/health', (_req, res) => res.json({ ok: true }));
    probe.get('/api/health/ready', (_req, res) => res.status(503).json({ ok: false }));
    probe.get('/api/projects', (_req, res) => res.json([]));
    await request(probe).get('/api/health');
    await request(probe).get('/api/health/ready');
    await request(probe).get('/api/projects');
    const log = lines.join('');
    expect(log).not.toMatch(/GET \/api\/health 200/);
    expect(log).toMatch(/GET \/api\/health\/ready 503/);
    expect(log).toMatch(/GET \/api\/projects 200/);
  });

  it('redactUrlForLog keeps paths without a query unchanged', () => {
    expect(redactUrlForLog('/api/health')).toBe('/api/health');
    expect(redactUrlForLog('/api/x?flag')).toBe('/api/x?flag=[REDACTED]');
  });
});
