/**
 * Issue #18: Redis-backed one-time codes, ACL user wiring and backend selection.
 */
import RedisMock from 'ioredis-mock';
import {
  StateStoreUnavailableError,
  buildApiAclSetUserArgs,
  deriveApiRedisPassword,
  redisKey,
  setRedisClientForTests,
  stateBackend,
  pingRedis,
} from '../../../src/lib/redis';
import { RedisCodeStore, createCodeStore } from '../../../src/lib/oidc-codes';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failing: any = new Proxy({}, {
  get: (_t, prop) => (prop === 'then' ? undefined : () => Promise.reject(new Error('ECONNREFUSED'))),
});

afterEach(() => setRedisClientForTests(null));

describe('backend selection', () => {
  const saved = process.env.PLATFORM_STATE_STORE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PLATFORM_STATE_STORE;
    else process.env.PLATFORM_STATE_STORE = saved;
  });

  it('uses memory only under tests by default, Redis once a client is configured', () => {
    expect(stateBackend()).toBe('memory');
    setRedisClientForTests(new RedisMock() as any);
    expect(stateBackend()).toBe('redis');
  });

  it('honours PLATFORM_STATE_STORE=redis', () => {
    process.env.PLATFORM_STATE_STORE = 'redis';
    expect(stateBackend()).toBe('redis');
  });

  it('defaults to Redis outside tests', () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      delete process.env.PLATFORM_STATE_STORE;
      expect(stateBackend()).toBe('redis');
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});

describe('ACL user', () => {
  it('confines keys and channels to the API prefix and blocks admin commands', () => {
    const args = buildApiAclSetUserArgs('plat-api', 'pw');
    expect(args.slice(0, 4)).toEqual(['SETUSER', 'plat-api', 'on', '>pw']);
    expect(args).toContain('~plat:api:*');
    expect(args).toContain('&plat:api:*');
    expect(args).toContain('resetkeys');
    expect(args).toContain('resetchannels');
    expect(args).toContain('-@admin');
    expect(args).toContain('-@dangerous');
    expect(args).not.toContain('resetpass'); // pre-rotation replicas keep working
  });

  it('derives a stable password from the platform Redis secret', () => {
    expect(deriveApiRedisPassword('secret')).toBe(deriveApiRedisPassword('secret'));
    expect(deriveApiRedisPassword('secret')).not.toBe(deriveApiRedisPassword('other'));
    expect(deriveApiRedisPassword('secret')).not.toContain('secret');
  });

  it('prefixes keys', () => {
    expect(redisKey('oauth-state:x')).toBe('plat:api:oauth-state:x');
  });
});

describe('RedisCodeStore', () => {
  let redis: any;
  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    setRedisClientForTests(redis);
  });

  it('issues codes with a TTL under the API prefix and redeems them once', async () => {
    const store = new RedisCodeStore<{ userId: string }>('test', 60_000);
    const code = await store.issue({ userId: 'u1' });
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = await redis.pttl(`plat:api:test:${code}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await store.consume(code)).toEqual({ userId: 'u1' });
    expect(await store.consume(code)).toBeNull();
  });

  it('codes issued by one replica are redeemable by another, exactly once', async () => {
    const podA = new RedisCodeStore<number>('shared', 60_000);
    const podB = new RedisCodeStore<number>('shared', 60_000);
    const code = await podA.issue(42);
    const results = await Promise.all([podA.consume(code), podB.consume(code), podB.consume(code)]);
    expect(results.filter((r) => r === 42)).toHaveLength(1);
  });

  it('expires codes', async () => {
    const store = new RedisCodeStore<number>('short', 30);
    const code = await store.issue(1);
    await sleep(80);
    expect(await store.consume(code)).toBeNull();
  });

  it('rejects malformed codes without touching Redis', async () => {
    const store = new RedisCodeStore<number>('x', 1000);
    const spy = jest.spyOn(redis, 'getdel');
    expect(await store.consume(undefined)).toBeNull();
    expect(await store.consume('')).toBeNull();
    expect(await store.consume('a:b*c')).toBeNull();
    expect(await store.consume('a'.repeat(500))).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('createCodeStore switches to Redis when it is configured', async () => {
    const store = createCodeStore<string>('sw', 60_000);
    const code = await store.issue('v');
    expect(await redis.exists(`plat:api:sw:${code}`)).toBe(1);
    expect(await store.consume(code)).toBe('v');
  });
});

describe('fail closed', () => {
  it('throws StateStoreUnavailableError (503) when Redis errors', async () => {
    setRedisClientForTests(failing);
    const store = new RedisCodeStore<number>('down', 1000);
    await expect(store.issue(1)).rejects.toBeInstanceOf(StateStoreUnavailableError);
    await expect(store.consume('a'.repeat(43))).rejects.toMatchObject({ status: 503 });
  });

  it('times out a hung Redis instead of hanging the request', async () => {
    const hung: any = { set: () => new Promise(() => {}), getdel: () => new Promise(() => {}) };
    setRedisClientForTests(hung);
    process.env.REDIS_OP_TIMEOUT_MS = '50';
    const { withRedis } = jest.requireActual('../../../src/lib/redis');
    await expect(withRedis((r: any) => r.set('k'), 50)).rejects.toBeInstanceOf(StateStoreUnavailableError);
  });

  it('pingRedis reports skipped in memory mode and errors when down', async () => {
    expect(await pingRedis()).toBe('skipped');
    setRedisClientForTests(failing);
    expect(await pingRedis()).not.toBe('ok');
    setRedisClientForTests(new RedisMock() as any);
    expect(await pingRedis()).toBe('ok');
  });
});
