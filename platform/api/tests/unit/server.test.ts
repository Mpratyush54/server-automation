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
const { buildApp, jsonBodyParser } = require('../../src/server');

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
});
