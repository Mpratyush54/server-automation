/**
 * lib/locks — acquire / release / expiry / renewal / fencing for the Redis, Postgres advisory
 * and in-process backends.
 */
const pgState: { locked: Set<string>; available: boolean } = { locked: new Set(), available: false };
let txid = 1000;

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => {
    if (!pgState.available) return { getRepository: () => ({}) }; // no createQueryRunner → memory
    return {
      createQueryRunner: () => {
        const held = new Set<string>();
        const qr: any = {
          isReleased: false,
          connect: jest.fn().mockResolvedValue(undefined),
          release: jest.fn().mockImplementation(async () => {
            qr.isReleased = true;
            for (const k of held) pgState.locked.delete(k); // session end frees advisory locks
          }),
          query: jest.fn().mockImplementation(async (sql: string, params?: any[]) => {
            const k = params ? `${params[0]}:${params[1]}` : '';
            if (sql.includes('pg_try_advisory_lock')) {
              if (pgState.locked.has(k)) return [{ ok: false }];
              pgState.locked.add(k);
              held.add(k);
              return [{ ok: true }];
            }
            if (sql.includes('pg_advisory_unlock')) {
              pgState.locked.delete(k);
              held.delete(k);
              return [{ pg_advisory_unlock: true }];
            }
            if (sql.includes('txid_current')) return [{ f: String(++txid) }];
            return [];
          }),
        };
        return qr;
      },
    };
  }),
}));

import {
  acquireLock,
  acquireLockOrThrow,
  getLockHolder,
  LockBusyError,
  lockBusyBody,
  platformLockKey,
  projectLockKey,
  resetMemoryLocksForTests,
  setLockHolderResolver,
  withLock,
} from '../../../src/lib/locks';
import { setCoordinationRedisForTests } from '../../../src/lib/coord-redis';

/** Minimal Redis double that understands the three Lua scripts used by lib/locks. */
class FakeRedis {
  store = new Map<string, { v: string; exp: number | null }>();
  status = 'ready';
  failNext = false;
  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.exp !== null && e.exp <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string) {
    return this.live(key)?.v ?? null;
  }
  async eval(script: string, _n: number, ...args: string[]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('ECONNRESET');
    }
    if (script.includes("'NX'")) {
      const [key, fenceKey, value, ttl] = args;
      if (this.live(key)) return 0;
      this.store.set(key, { v: value, exp: Date.now() + Number(ttl) });
      const f = Number(this.live(fenceKey)?.v || '0') + 1;
      this.store.set(fenceKey, { v: String(f), exp: null });
      return f;
    }
    const [key, value, ttl] = args;
    const e = this.live(key);
    if (!e || e.v !== value) return 0;
    if (script.includes("'DEL'")) {
      this.store.delete(key);
      return 1;
    }
    e.exp = Date.now() + Number(ttl);
    return 1;
  }
}

describe('lock keys', () => {
  it('builds project and platform keys', () => {
    expect(projectLockKey('p1', 'deploy', 'env1')).toBe('lock:project:p1:deploy:env1');
    expect(projectLockKey('p1', 'db-provision')).toBe('lock:project:p1:db-provision');
    expect(platformLockKey('secret-rotation')).toBe('lock:platform:secret-rotation');
  });
});

describe('memory backend (no Redis, no Postgres query runner)', () => {
  beforeEach(() => {
    setCoordinationRedisForTests(null);
    pgState.available = false;
    resetMemoryLocksForTests();
  });

  it('second acquire fails while held; release frees it', async () => {
    const a = await acquireLock('k1', { holder: 'op-a' });
    expect(a?.backend).toBe('memory');
    expect(await acquireLock('k1', { holder: 'op-b' })).toBeNull();
    expect(await getLockHolder('k1')).toBe('op-a');
    await a!.release();
    const b = await acquireLock('k1', { holder: 'op-b' });
    expect(b).not.toBeNull();
    expect(b!.fence).not.toBe(a!.fence);
    await b!.release();
  });

  it('expires after ttl when not renewed', async () => {
    const a = await acquireLock('k-exp', { holder: 'op-a', ttlMs: 50, renew: false });
    expect(a).not.toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    const b = await acquireLock('k-exp', { holder: 'op-b', ttlMs: 50, renew: false });
    expect(b).not.toBeNull();
    // the expired holder can no longer extend nor release the new holder's lock
    expect(await a!.extend()).toBe(false);
    expect(a!.lost).toBe(true);
    await a!.release();
    expect(await acquireLock('k-exp', { holder: 'op-c' })).toBeNull();
    await b!.release();
  });

  it('auto-renews while held', async () => {
    const a = await acquireLock('k-renew', { holder: 'op-a', ttlMs: 300 });
    await new Promise((r) => setTimeout(r, 700));
    expect(a!.lost).toBe(false);
    expect(await acquireLock('k-renew', { holder: 'op-b' })).toBeNull();
    await a!.release();
  });

  it('acquireLockOrThrow / withLock report the holder', async () => {
    const a = await acquireLockOrThrow('k-busy', { holder: 'op-holder' });
    await expect(withLock('k-busy', { holder: 'op-x' }, async () => 1)).rejects.toBeInstanceOf(LockBusyError);
    try {
      await acquireLockOrThrow('k-busy', { holder: 'op-x' });
    } catch (err: any) {
      expect(lockBusyBody(err)).toMatchObject({ code: 'OPERATION_IN_PROGRESS', operationId: 'op-holder', lockKey: 'k-busy' });
    }
    await a.release();
    await expect(withLock('k-busy', { holder: 'op-x' }, async () => 42)).resolves.toBe(42);
    expect(await acquireLock('k-busy', { holder: 'op-y' })).not.toBeNull();
  });
});

describe('redis backend', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    setCoordinationRedisForTests(redis as any);
    pgState.available = false;
    resetMemoryLocksForTests();
  });
  afterAll(() => setCoordinationRedisForTests(undefined));

  it('SET NX with a token; fences increase; holder readable from another process', async () => {
    const a = await acquireLock('lock:project:p:deploy:e', { holder: 'op-1' });
    expect(a?.backend).toBe('redis');
    expect(a?.fence).toBe('r:1');
    expect(await acquireLock('lock:project:p:deploy:e', { holder: 'op-2' })).toBeNull();
    resetMemoryLocksForTests(); // forget local holders: read it back from Redis
    expect(await getLockHolder('lock:project:p:deploy:e')).toBe('op-1');
    await a!.release();
    expect(await redis.get('lock:project:p:deploy:e')).toBeNull();
    const b = await acquireLock('lock:project:p:deploy:e', { holder: 'op-2' });
    expect(b?.fence).toBe('r:2');
    await b!.release();
  });

  it('release by a stale holder never deletes the new holder\'s lock', async () => {
    const a = await acquireLock('k', { holder: 'op-1', ttlMs: 40, renew: false });
    await new Promise((r) => setTimeout(r, 60));
    const b = await acquireLock('k', { holder: 'op-2', ttlMs: 5000 });
    expect(b).not.toBeNull();
    await a!.release();
    expect(await redis.get('k')).toContain('op-2');
    await b!.release();
  });

  it('renewal keeps the lease alive past the ttl', async () => {
    const a = await acquireLock('k-r', { holder: 'op-1', ttlMs: 300 });
    await new Promise((r) => setTimeout(r, 800));
    expect(a!.lost).toBe(false);
    expect(await redis.get('k-r')).toContain('op-1');
    await a!.release();
  });

  it('a transient Redis error during renewal does not drop the lease', async () => {
    const a = await acquireLock('k-t', { holder: 'op-1', ttlMs: 3000, renew: false });
    redis.failNext = true;
    expect(await a!.extend()).toBe(true);
    expect(a!.lost).toBe(false);
    await a!.release();
  });

  it('falls back to another backend when Redis errors on acquire', async () => {
    redis.failNext = true;
    const a = await acquireLock('k-f', { holder: 'op-1' });
    expect(a?.backend).toBe('memory');
    await a!.release();
  });
});

describe('postgres advisory fallback (Redis down)', () => {
  beforeEach(() => {
    setCoordinationRedisForTests(null);
    pgState.available = true;
    pgState.locked.clear();
    resetMemoryLocksForTests();
  });
  afterAll(() => {
    pgState.available = false;
    setLockHolderResolver(null);
  });

  it('uses pg_try_advisory_lock on a dedicated session and unlocks on release', async () => {
    const a = await acquireLock('lock:platform:secret-rotation', { holder: 'op-1' });
    expect(a?.backend).toBe('postgres');
    expect(a?.fence).toMatch(/^p:\d+$/);
    expect(pgState.locked.size).toBe(1);
    resetMemoryLocksForTests();
    setLockHolderResolver(async () => 'op-1');
    expect(await acquireLock('lock:platform:secret-rotation', { holder: 'op-2' })).toBeNull();
    expect(await getLockHolder('lock:platform:secret-rotation')).toBe('op-1');
    await a!.release();
    expect(pgState.locked.size).toBe(0);
    const b = await acquireLock('lock:platform:secret-rotation', { holder: 'op-2' });
    expect(b?.backend).toBe('postgres');
    await b!.release();
  });
});
