import * as crypto from 'crypto';
import { redisKey, stateBackend, withRedis } from './redis';

/** Async single-use code store shared by every API replica (see {@link createCodeStore}). */
export interface CodeStore<T> {
  /** Store `value` under a fresh random code for the store's TTL and return the code. */
  issue(value: T): Promise<string>;
  /** Atomically fetch-and-delete; null when unknown, expired or already redeemed. */
  consume(code: unknown): Promise<T | null>;
}

function newCode(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function validCode(code: unknown): code is string {
  // Codes are base64url (43 chars); anything else cannot be ours. Bound the key length.
  return typeof code === 'string' && code.length > 0 && code.length <= 128 && /^[A-Za-z0-9_-]+$/.test(code);
}

/**
 * Redis-backed store: `SET plat:api:<ns>:<code> <json> PX ttl NX` to issue and `GETDEL` to
 * redeem, so a code can be redeemed at most once across all replicas. Redis errors throw
 * StateStoreUnavailableError (fail closed — callers answer 503).
 */
export class RedisCodeStore<T> implements CodeStore<T> {
  constructor(private readonly namespace: string, private readonly ttlMs: number) {}

  private key(code: string): string {
    return redisKey(`${this.namespace}:${code}`);
  }

  async issue(value: T): Promise<string> {
    const payload = JSON.stringify(value);
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = newCode();
      const ok = await withRedis((r) => r.set(this.key(code), payload, 'PX', this.ttlMs, 'NX'));
      if (ok === 'OK') return code;
    }
    throw new Error('could not allocate a unique code');
  }

  async consume(code: unknown): Promise<T | null> {
    if (!validCode(code)) return null;
    const raw = await withRedis((r) => r.getdel(this.key(code)));
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}

/**
 * Store for a namespace whose backend is chosen per call: Redis in deployments, the in-memory
 * {@link OneTimeCodeStore} only under tests / explicit PLATFORM_STATE_STORE=memory.
 */
export function createCodeStore<T>(namespace: string, ttlMs: number): CodeStore<T> & { clearMemory(): void } {
  const memory = new OneTimeCodeStore<T>(ttlMs);
  const redis = new RedisCodeStore<T>(namespace, ttlMs);
  return {
    issue: async (value) => (stateBackend() === 'redis' ? redis.issue(value) : memory.issue(value)),
    consume: async (code) => (stateBackend() === 'redis' ? redis.consume(code) : memory.consume(code)),
    clearMemory: () => memory.clear(),
  };
}

/**
 * In-memory store for short-lived, single-use codes. Used by unit tests and single-process
 * dev mode only (it is per-process, so it breaks with more than one replica); production
 * uses {@link RedisCodeStore} via {@link createCodeStore}. `consume` deletes before
 * returning, so a code can be redeemed at most once.
 */
export class OneTimeCodeStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 10_000) {}

  issue(value: T): string {
    this.purge();
    if (this.entries.size >= this.maxEntries) {
      // Drop the oldest entry rather than growing without bound.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const code = crypto.randomBytes(32).toString('base64url');
    this.entries.set(code, { value, expiresAt: Date.now() + this.ttlMs });
    return code;
  }

  consume(code: unknown): T | null {
    if (typeof code !== 'string' || !code) return null;
    const entry = this.entries.get(code);
    if (!entry) return null;
    this.entries.delete(code);
    if (entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private purge(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyPkceS256(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
