/**
 * Issue #18: rate-limit counters live in Redis (rate-limit-redis) and are shared by every
 * replica; if Redis is down the limiter degrades to per-replica memory, never to "no limit".
 */
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import RedisMock from 'ioredis-mock';
import { FallbackRedisStore, createLimiterStore } from '../../../src/lib/rate-limit-store';
import { setRedisClientForTests } from '../../../src/lib/redis';

/** ioredis-mock lacks `call` and SCRIPT; emulate them with EVAL so rate-limit-redis can run. */
function withCall(redis: any): any {
  const scripts = new Map<string, string>();
  redis.call = async (cmd: string, ...args: string[]) => {
    const c = cmd.toUpperCase();
    if (c === 'SCRIPT' && String(args[0]).toUpperCase() === 'LOAD') {
      const sha = crypto.createHash('sha1').update(args[1]).digest('hex');
      scripts.set(sha, args[1]);
      return sha;
    }
    if (c === 'EVALSHA') {
      const script = scripts.get(args[0]);
      if (!script) throw new Error('NOSCRIPT');
      return redis.eval(script, ...args.slice(1));
    }
    return redis[c.toLowerCase()](...args);
  };
  return redis;
}

function app(store: any, limit = 3) {
  const a = express();
  a.set('trust proxy', 1);
  a.use(rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, store }));
  a.get('/x', (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => setRedisClientForTests(null));

describe('createLimiterStore', () => {
  it('uses the default memory store under tests and Redis when configured', () => {
    expect(createLimiterStore('credential')).toBeUndefined();
    setRedisClientForTests(withCall(new RedisMock()));
    const store = createLimiterStore('credential') as FallbackRedisStore;
    expect(store).toBeInstanceOf(FallbackRedisStore);
    expect(store.prefix).toBe('plat:api:rl:credential:');
    expect(store.localKeys).toBe(false);
  });
});

describe('FallbackRedisStore', () => {
  it('shares counters across replicas', async () => {
    const redis = withCall(new RedisMock());
    await redis.flushall();
    setRedisClientForTests(redis);
    const podA = app(new FallbackRedisStore('shared'));
    const podB = app(new FallbackRedisStore('shared'));
    const statuses: number[] = [];
    for (const pod of [podA, podB, podA, podB]) {
      statuses.push((await request(pod).get('/x').set('X-Forwarded-For', '203.0.113.9')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    const keys = await redis.keys('plat:api:rl:shared:*');
    expect(keys.length).toBe(1);
  });

  it('keeps separate counters per limiter prefix', async () => {
    const redis = withCall(new RedisMock());
    await redis.flushall();
    setRedisClientForTests(redis);
    const cred = app(new FallbackRedisStore('credential'), 1);
    const issue = app(new FallbackRedisStore('issue'), 1);
    expect((await request(cred).get('/x')).status).toBe(200);
    expect((await request(issue).get('/x')).status).toBe(200);
    expect((await request(cred).get('/x')).status).toBe(429);
  });

  it('falls back to per-replica limits (not unlimited) when Redis is down', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const down: any = new Proxy({}, {
      get: (_t, prop) => (prop === 'then' ? undefined : () => Promise.reject(new Error('ECONNREFUSED'))),
    });
    setRedisClientForTests(down);
    const pod = app(new FallbackRedisStore('down'), 2);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(pod).get('/x')).status);
    expect(statuses).toEqual([200, 200, 429]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[rate-limit] Redis unavailable'));
    warn.mockRestore();
  });
});
