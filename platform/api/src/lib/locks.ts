import crypto from 'crypto';
import type Redis from 'ioredis';
import { readyCoordinationRedis } from './coord-redis';

/**
 * Resource locks for mutating operations.
 *
 * Primary backend: Redis `SET key value NX PX ttl` with a random token, released and renewed by
 * Lua scripts that compare the token (a holder can never release or extend someone else's lock).
 * The lock auto-renews every ttl/3 while held; if the process dies the key expires after `ttl`.
 *
 * Fallback when Redis is not configured or unreachable: a Postgres session advisory lock held on
 * a dedicated connection (released when the connection closes, so a crash frees it as well).
 * Last resort (no Redis, no usable Postgres — tests, local dev): an in-process lock.
 *
 * Every acquisition returns a unique fencing token. Operations store it when they claim a run and
 * every later write is conditional on it, so a runner whose lock silently expired cannot overwrite
 * the progress of the runner that took over.
 *
 * Known limitation: if Redis is reachable from one API replica but not from another, the two can
 * pick different backends. Redis is single-primary in every install profile, so this needs a
 * network partition between API pods and Redis only.
 */

export type LockBackend = 'redis' | 'postgres' | 'memory';

export interface LockHandle {
  readonly key: string;
  readonly holder: string;
  readonly token: string;
  /** Unique fencing token for this acquisition (prefixed by backend). */
  readonly fence: string;
  readonly backend: LockBackend;
  /** True once renewal failed and the lock may be held by someone else. */
  readonly lost: boolean;
  /** Extend the TTL now (also done automatically). Resolves false when the lock was lost. */
  extend(): Promise<boolean>;
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** Who holds the lock (normally the operation id) — reported to callers that get 409. */
  holder: string;
  /** Lease length; renewed every ttl/3. Default 30 s. */
  ttlMs?: number;
  /** Auto-renew while held (default true). */
  renew?: boolean;
}

export const DEFAULT_LOCK_TTL_MS = 30_000;

/** `lock:project:<projectId>:<op>[:<resource>]` */
export function projectLockKey(projectId: string, op: string, resource?: string | null): string {
  return `lock:project:${projectId}:${op}${resource ? `:${resource}` : ''}`;
}

/** Platform-wide lock (not tied to a project), e.g. `lock:platform:secret-rotation`. */
export function platformLockKey(op: string): string {
  return `lock:platform:${op}`;
}

const ACQUIRE_LUA = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])
end
return 0`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

const EXTEND_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

/** Resolves the holder of a lock that is not visible in Redis/memory (e.g. Postgres advisory). */
type HolderResolver = (key: string) => Promise<string | null>;
let holderResolver: HolderResolver | null = null;
export function setLockHolderResolver(fn: HolderResolver | null): void {
  holderResolver = fn;
}

// Locks held by this process (any backend) → holder, for fast holder lookups and diagnostics.
const localHolders = new Map<string, string>();

// ── memory backend ──────────────────────────────────────────────────────────
const memLocks = new Map<string, { value: string; holder: string; expiresAt: number }>();
let memFence = 0;

function memGet(key: string) {
  const e = memLocks.get(key);
  if (e && e.expiresAt <= Date.now()) {
    memLocks.delete(key);
    return undefined;
  }
  return e;
}

/** Test hook: drop every in-process lock. */
export function resetMemoryLocksForTests(): void {
  memLocks.clear();
  localHolders.clear();
}

// ── helpers ─────────────────────────────────────────────────────────────────
function advisoryKeys(key: string): [number, number] {
  const h = crypto.createHash('sha256').update(key).digest();
  return [h.readInt32BE(0), h.readInt32BE(4)];
}

let warnedMemory = false;
function warnMemory(reason: string) {
  if (warnedMemory || process.env.NODE_ENV === 'test') return;
  warnedMemory = true;
  console.warn(`[locks] Redis and Postgres advisory locks unavailable (${reason}); using in-process locks (single replica only)`);
}

class Handle implements LockHandle {
  lost = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private released = false;
  private lastRenewOk = Date.now();

  constructor(
    readonly key: string,
    readonly holder: string,
    readonly token: string,
    readonly fence: string,
    readonly backend: LockBackend,
    private readonly ttlMs: number,
    private readonly doExtend: () => Promise<boolean>,
    private readonly doRelease: () => Promise<void>,
    renew: boolean,
  ) {
    localHolders.set(key, holder);
    if (renew && backend !== 'postgres') {
      this.timer = setInterval(() => { void this.extend(); }, Math.max(250, Math.floor(ttlMs / 3)));
      (this.timer as any).unref?.();
    }
  }

  async extend(): Promise<boolean> {
    if (this.released || this.lost) return false;
    try {
      const ok = await this.doExtend();
      if (ok) {
        this.lastRenewOk = Date.now();
        return true;
      }
      this.markLost();
      return false;
    } catch {
      // Backend hiccup: keep the lease until it would have expired.
      if (Date.now() - this.lastRenewOk >= this.ttlMs) this.markLost();
      return !this.lost;
    }
  }

  private markLost() {
    this.lost = true;
    this.stopTimer();
    if (localHolders.get(this.key) === this.holder) localHolders.delete(this.key);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopTimer();
    if (localHolders.get(this.key) === this.holder) localHolders.delete(this.key);
    try {
      await this.doRelease();
    } catch (err: any) {
      console.warn(`[locks] release of ${this.key} failed (expires on its own): ${err?.message || err}`);
    }
  }
}

async function acquireRedis(redis: Redis, key: string, holder: string, ttlMs: number, renew: boolean): Promise<LockHandle | null> {
  const token = crypto.randomBytes(16).toString('hex');
  const value = JSON.stringify({ t: token, h: holder });
  const fence = Number(await redis.eval(ACQUIRE_LUA, 2, key, `${key}:fence`, value, String(ttlMs)));
  if (!fence) return null;
  return new Handle(
    key, holder, token, `r:${fence}`, 'redis', ttlMs,
    async () => Number(await redis.eval(EXTEND_LUA, 1, key, value, String(ttlMs))) === 1,
    async () => { await redis.eval(RELEASE_LUA, 1, key, value); },
    renew,
  );
}

async function acquirePostgres(key: string, holder: string, ttlMs: number): Promise<LockHandle | null | 'unavailable'> {
  let qr: any;
  try {
    const { getDb } = await import('../config/database');
    const ds: any = await getDb();
    if (typeof ds?.createQueryRunner !== 'function') return 'unavailable';
    qr = ds.createQueryRunner();
    await qr.connect();
  } catch {
    try { await qr?.release(); } catch {}
    return 'unavailable';
  }
  const [k1, k2] = advisoryKeys(key);
  try {
    const rows = await qr.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [k1, k2]);
    if (!rows?.[0]?.ok) {
      await qr.release();
      return null;
    }
    const f = await qr.query('SELECT txid_current()::text AS f');
    const token = crypto.randomBytes(16).toString('hex');
    return new Handle(
      key, holder, token, `p:${f?.[0]?.f ?? token}`, 'postgres', ttlMs,
      async () => !qr.isReleased,
      async () => {
        try { await qr.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]); } finally { await qr.release(); }
      },
      false,
    );
  } catch {
    try { await qr.release(); } catch {}
    return 'unavailable';
  }
}

function acquireMemory(key: string, holder: string, ttlMs: number, renew: boolean): LockHandle | null {
  if (memGet(key)) return null;
  const token = crypto.randomBytes(16).toString('hex');
  memLocks.set(key, { value: token, holder, expiresAt: Date.now() + ttlMs });
  memFence += 1;
  return new Handle(
    key, holder, token, `m:${Date.now()}-${memFence}`, 'memory', ttlMs,
    async () => {
      const e = memGet(key);
      if (!e || e.value !== token) return false;
      e.expiresAt = Date.now() + ttlMs;
      return true;
    },
    async () => {
      const e = memLocks.get(key);
      if (e && e.value === token) memLocks.delete(key);
    },
    renew,
  );
}

/**
 * Try to take a lock. Resolves null when someone else holds it (no waiting).
 */
export async function acquireLock(key: string, opts: AcquireOptions): Promise<LockHandle | null> {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const renew = opts.renew !== false;
  const redis = await readyCoordinationRedis();
  if (redis) {
    try {
      return await acquireRedis(redis, key, opts.holder, ttlMs, renew);
    } catch (err: any) {
      console.warn(`[locks] Redis lock failed for ${key}, falling back to Postgres: ${err?.message || err}`);
    }
  }
  const pg = await acquirePostgres(key, opts.holder, ttlMs);
  if (pg !== 'unavailable') return pg;
  warnMemory('no Redis, Postgres query runner unavailable');
  return acquireMemory(key, opts.holder, ttlMs, renew);
}

/** Current holder (operation id) of a lock, or null when free/unknown. */
export async function getLockHolder(key: string): Promise<string | null> {
  const local = localHolders.get(key);
  if (local) return local;
  const mem = memGet(key);
  if (mem) return mem.holder;
  const redis = await readyCoordinationRedis();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        try { return String(JSON.parse(raw).h || '') || null; } catch { return null; }
      }
    } catch {}
  }
  if (holderResolver) {
    try { return await holderResolver(key); } catch {}
  }
  return null;
}

export class LockBusyError extends Error {
  readonly status = 409;
  constructor(readonly key: string, readonly holder: string | null) {
    super('Another operation is already running for this resource');
    this.name = 'LockBusyError';
  }
}

/** Acquire or throw LockBusyError (with the holder's operation id). */
export async function acquireLockOrThrow(key: string, opts: AcquireOptions): Promise<LockHandle> {
  const handle = await acquireLock(key, opts);
  if (handle) return handle;
  throw new LockBusyError(key, await getLockHolder(key));
}

/** Run `fn` while holding `key`; throws LockBusyError when held elsewhere. */
export async function withLock<T>(key: string, opts: AcquireOptions, fn: (lock: LockHandle) => Promise<T>): Promise<T> {
  const lock = await acquireLockOrThrow(key, opts);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}

/** JSON body for a 409 caused by a busy lock. */
export function lockBusyBody(err: LockBusyError): Record<string, unknown> {
  return {
    error: err.message,
    code: 'OPERATION_IN_PROGRESS',
    operationId: err.holder,
    lockKey: err.key,
  };
}
