import { Request, Response, NextFunction } from 'express';
import { readyCoordinationRedis } from '../lib/coord-redis';
import { encryptValue, decryptValue } from '../lib/secrets-encryption';
import { coordinationEncryptionKey, sha256Hex, stableHash } from '../lib/stable-hash';
import { AuthenticatedRequest } from './auth';

/**
 * Idempotency-Key support for mutating routes (issue #23).
 *
 * - The first request with a key reserves (user, route, key) and runs normally; its final
 *   response is stored for 24 h (encrypted — some responses carry one-time credentials).
 * - A retry with the same key and the same body gets the stored response replayed
 *   (`Idempotent-Replayed: true`) without re-executing the handler.
 * - The same key with a different body → 422. While the first request is still running → 409.
 * - Responses that are worth retrying (408/409/425/429 and 5xx) are not stored: the
 *   reservation is dropped so the client can retry with the same key.
 *
 * Storage: Redis when available, else the `idempotency_keys` Postgres table, else memory.
 * Mount after authentication so the key is scoped to the caller.
 */

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
const IN_PROGRESS_TTL_MS = 15 * 60_000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export interface IdemRecord {
  state: 'in_progress' | 'completed';
  requestHash: string;
  status?: number;
  /** Encrypted JSON of the response body. */
  body?: string;
}

export interface IdempotencyStore {
  /** Reserve; returns the existing record when the key is already known. */
  reserve(id: string, meta: { userId: string; route: string }, rec: IdemRecord, ttlMs: number): Promise<IdemRecord | null>;
  complete(id: string, rec: IdemRecord, ttlMs: number): Promise<void>;
  release(id: string): Promise<void>;
}

// ── memory ───────────────────────────────────────────────────────────────────
export class MemoryIdempotencyStore implements IdempotencyStore {
  private m = new Map<string, { rec: IdemRecord; expiresAt: number }>();
  async reserve(id: string, _meta: { userId: string; route: string }, rec: IdemRecord, ttlMs: number) {
    const e = this.m.get(id);
    if (e && e.expiresAt > Date.now()) return e.rec;
    this.m.set(id, { rec, expiresAt: Date.now() + ttlMs });
    return null;
  }
  async complete(id: string, rec: IdemRecord, ttlMs: number) {
    this.m.set(id, { rec, expiresAt: Date.now() + ttlMs });
  }
  async release(id: string) {
    this.m.delete(id);
  }
  clear() {
    this.m.clear();
  }
}

// ── redis ────────────────────────────────────────────────────────────────────
class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: any) {}
  private k(id: string) { return `idem:${id}`; }
  async reserve(id: string, _meta: { userId: string; route: string }, rec: IdemRecord, ttlMs: number) {
    const ok = await this.redis.set(this.k(id), JSON.stringify(rec), 'PX', ttlMs, 'NX');
    if (ok) return null;
    const raw = await this.redis.get(this.k(id));
    if (!raw) return this.reserve(id, _meta, rec, ttlMs);
    return JSON.parse(raw) as IdemRecord;
  }
  async complete(id: string, rec: IdemRecord, ttlMs: number) {
    await this.redis.set(this.k(id), JSON.stringify(rec), 'PX', ttlMs);
  }
  async release(id: string) {
    await this.redis.del(this.k(id));
  }
}

// ── postgres ─────────────────────────────────────────────────────────────────
class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly ds: any, private readonly Entity: any) {}
  async reserve(id: string, meta: { userId: string; route: string }, rec: IdemRecord, ttlMs: number) {
    const repo = this.ds.getRepository(this.Entity);
    // Drop an expired row first so the insert can win.
    await repo.createQueryBuilder().delete().where('id = :id AND expires_at < now()', { id }).execute();
    const res = await repo.createQueryBuilder()
      .insert()
      .values({
        id, userId: meta.userId, route: meta.route, requestHash: rec.requestHash, state: rec.state,
        responseStatus: null, responseBody: null, expiresAt: new Date(Date.now() + ttlMs),
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    // ON CONFLICT DO NOTHING RETURNING id → one row when we inserted, none when the key existed.
    const inserted = Array.isArray(res?.raw) && res.raw.length > 0;
    if (inserted) return null;
    const row = await repo.findOne({ where: { id } });
    if (!row) return null;
    return { state: row.state, requestHash: row.requestHash, status: row.responseStatus ?? undefined, body: row.responseBody ?? undefined };
  }
  async complete(id: string, rec: IdemRecord, ttlMs: number) {
    await this.ds.getRepository(this.Entity).update({ id }, {
      state: rec.state, responseStatus: rec.status ?? null, responseBody: rec.body ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    });
  }
  async release(id: string) {
    await this.ds.getRepository(this.Entity).delete({ id });
  }
}

let storeOverride: IdempotencyStore | null = null;
const memoryStore = new MemoryIdempotencyStore();

export function setIdempotencyStore(store: IdempotencyStore | null): void {
  storeOverride = store;
}

async function resolveStore(): Promise<{ store: IdempotencyStore; durable: boolean }> {
  if (storeOverride) return { store: storeOverride, durable: false };
  const redis = await readyCoordinationRedis();
  if (redis) return { store: new RedisIdempotencyStore(redis), durable: true };
  try {
    const { getDb } = await import('../config/database');
    const ds: any = await getDb();
    const { IdempotencyKey } = await import('../entities/IdempotencyKey');
    const repo = ds?.getRepository?.(IdempotencyKey);
    if (repo && typeof repo.createQueryBuilder === 'function') {
      return { store: new PostgresIdempotencyStore(ds, IdempotencyKey), durable: true };
    }
  } catch {}
  return { store: memoryStore, durable: false };
}

function encodeBody(body: unknown, durable: boolean): string | null {
  const json = JSON.stringify(body ?? null);
  const key = coordinationEncryptionKey();
  if (key) return `enc:${encryptValue(json, key)}`;
  // Never write plaintext response bodies to Redis/Postgres.
  return durable ? null : `raw:${json}`;
}

function decodeBody(stored: string): unknown {
  if (stored.startsWith('raw:')) return JSON.parse(stored.slice(4));
  const payload = stored.slice(4);
  const keys = Array.from(new Set([process.env.SECRETS_ENCRYPTION_KEY, process.env.JWT_SECRET].filter((k): k is string => !!k)));
  for (const k of keys) {
    try { return JSON.parse(decryptValue(payload, k)); } catch {}
  }
  throw new Error('cannot decrypt stored idempotent response');
}

function shouldStore(status: number): boolean {
  if (status >= 500) return false;
  return ![408, 409, 425, 429].includes(status);
}

/**
 * Express middleware. `routeName` identifies the operation (e.g. 'POST /deploy') so the same
 * key used on two different routes does not collide.
 */
export function idempotency(routeName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header('Idempotency-Key');
    if (header === undefined) return next();
    if (!KEY_RE.test(header)) {
      return res.status(400).json({ error: 'Idempotency-Key must be 1-255 printable ASCII characters' });
    }
    const user = (req as AuthenticatedRequest).user;
    const userId = user?.id || (req as AuthenticatedRequest).agentToken?.id || 'anonymous';
    const route = `${routeName}`;
    const id = sha256Hex(`${userId}\n${route}\n${header}`);
    const requestHash = stableHash({ params: req.params, body: req.body ?? null });

    let resolved: { store: IdempotencyStore; durable: boolean };
    let existing: IdemRecord | null;
    try {
      resolved = await resolveStore();
      existing = await resolved.store.reserve(id, { userId, route }, { state: 'in_progress', requestHash }, IN_PROGRESS_TTL_MS);
    } catch (err: any) {
      // Fall back to memory rather than failing the request (or silently double-executing).
      resolved = { store: memoryStore, durable: false };
      existing = await memoryStore.reserve(id, { userId, route }, { state: 'in_progress', requestHash }, IN_PROGRESS_TTL_MS);
    }
    const { store, durable } = resolved;

    if (existing) {
      if (existing.requestHash !== requestHash) {
        return res.status(422).json({
          error: 'Idempotency-Key was already used with a different request body',
          code: 'IDEMPOTENCY_KEY_REUSED',
        });
      }
      if (existing.state !== 'completed' || existing.status === undefined || !existing.body) {
        res.setHeader('Retry-After', '2');
        return res.status(409).json({
          error: 'A request with this Idempotency-Key is still being processed',
          code: 'IDEMPOTENCY_IN_PROGRESS',
        });
      }
      try {
        const body = decodeBody(existing.body);
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(existing.status).json(body);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Store the final response before it is sent, so an immediate retry already sees it.
    let settled = false;
    const settle = async (c: { status: number; body: unknown } | null) => {
      if (settled) return;
      settled = true;
      try {
        if (c && shouldStore(c.status)) {
          const encoded = encodeBody(c.body, durable);
          if (encoded) {
            await store.complete(id, { state: 'completed', requestHash, status: c.status, body: encoded }, IDEMPOTENCY_TTL_MS);
            return;
          }
        }
        await store.release(id);
      } catch (err: any) {
        console.warn(`[idempotency] could not store response for ${route}: ${err?.message || err}`);
      }
    };
    const origJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const status = res.statusCode;
      void settle({ status, body }).finally(() => origJson(body));
      return res;
    }) as Response['json'];
    // Responses not sent through res.json (or aborted requests) drop the reservation.
    res.on('close', () => { void settle(null); });
    return next();
  };
}
