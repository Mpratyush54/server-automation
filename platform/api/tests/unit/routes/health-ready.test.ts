/**
 * Issue #18: GET /api/health/ready gates traffic on the DB and on draining only. Redis is
 * reported but never gates readiness (an outage must not empty the Service); GET /api/health
 * stays a dependency-free liveness probe.
 */
const mockQuery = jest.fn();
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ query: mockQuery })),
}));

import express from 'express';
import request from 'supertest';
import RedisMock from 'ioredis-mock';
import healthRoutes from '../../../src/routes/health';
import { setRedisClientForTests } from '../../../src/lib/redis';
import { gracefulShutdown, resetShutdownStateForTests } from '../../../src/lib/shutdown';

const app = express();
app.use('/api', healthRoutes);

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue([{ '?column?': 1 }]);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setRedisClientForTests(null);
  resetShutdownStateForTests();
  jest.restoreAllMocks();
});

it('is ready when the DB answers (Redis skipped in memory mode)', async () => {
  const r = await request(app).get('/api/health/ready');
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: 'ready', checks: { db: 'ok', redis: 'skipped' } });
  expect(r.headers['cache-control']).toBe('no-store');
});

it('reports Redis when it is the state backend', async () => {
  setRedisClientForTests(new RedisMock() as any);
  const ok = await request(app).get('/api/health/ready');
  expect(ok.status).toBe(200);
  expect(ok.body.checks.redis).toBe('ok');
});

it('stays ready during a Redis outage (Redis-backed flows fail individually instead)', async () => {
  setRedisClientForTests({ ping: () => Promise.reject(new Error('NOAUTH secret-host:6379')) } as any);
  const down = await request(app).get('/api/health/ready');
  expect(down.status).toBe(200);
  expect(down.body).toEqual({ status: 'ready', checks: { db: 'ok', redis: 'unavailable' } });
  expect(JSON.stringify(down.body)).not.toContain('secret-host'); // no driver text on a public endpoint
});

it('is not ready when the DB fails even if Redis is fine', async () => {
  setRedisClientForTests(new RedisMock() as any);
  mockQuery.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5'));
  const r = await request(app).get('/api/health/ready');
  expect(r.status).toBe(503);
  expect(r.body.checks).toEqual({ db: 'unavailable', redis: 'ok' });
});

it('is not ready when the DB fails', async () => {
  mockQuery.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5'));
  const r = await request(app).get('/api/health/ready');
  expect(r.status).toBe(503);
  expect(r.body.checks.db).toBe('unavailable');
  expect(JSON.stringify(r.body)).not.toContain('10.0.0.5');
});

it('reports draining once shutdown has started', async () => {
  const server = { close: (cb: () => void) => cb() } as any;
  await gracefulShutdown(server, { log: () => {}, exit: () => {} });
  const r = await request(app).get('/api/health/ready');
  expect(r.status).toBe(503);
  expect(r.body.status).toBe('draining');
});
