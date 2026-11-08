import crypto from 'crypto';
import Redis, { RedisOptions } from 'ioredis';

/**
 * Shared Redis client for request-spanning API state (OAuth login state, one-time
 * codes, rate-limit counters, permission-cache invalidation).
 *
 * - Every key the API writes starts with {@link REDIS_KEY_PREFIX}; pub/sub channels too.
 * - The client authenticates as a dedicated ACL user ({@link API_REDIS_USER}) confined to
 *   that prefix. The user is (re)created idempotently from the platform Redis secret
 *   (REDIS_PASSWORD, the `default` user) so no extra secret has to be provisioned, and it
 *   is re-created automatically if Redis restarts without an ACL file.
 * - REDIS_API_USERNAME / REDIS_API_PASSWORD override this with an externally managed user.
 *
 * Backend selection ({@link stateBackend}): `redis` in every real deployment; `memory`
 * only under Jest (NODE_ENV=test) or when PLATFORM_STATE_STORE=memory is set explicitly
 * for a single-process dev setup. Memory mode is NOT safe with more than one replica.
 */

export const REDIS_KEY_PREFIX = 'plat:api:';
export const API_REDIS_USER = 'plat-api';
/** Upper bound for a single state-store round trip before we treat Redis as unavailable. */
export const REDIS_OP_TIMEOUT_MS = Number(process.env.REDIS_OP_TIMEOUT_MS) || 2000;

export type StateBackend = 'redis' | 'memory';

/** Thrown when security-sensitive state cannot be read or written (callers answer 503). */
export class StateStoreUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Session store unavailable', readonly cause?: unknown) {
    super(message);
    this.name = 'StateStoreUnavailableError';
  }
}

let testClient: Redis | null = null;
let clientPromise: Promise<Redis> | null = null;
let client: Redis | null = null;
let subscriber: Redis | null = null;
let warnedMemory = false;

export function stateBackend(): StateBackend {
  if (testClient) return 'redis';
  const explicit = String(process.env.PLATFORM_STATE_STORE || '').trim().toLowerCase();
  if (explicit === 'memory') {
    if (!warnedMemory && process.env.NODE_ENV !== 'test') {
      warnedMemory = true;
      console.warn('[redis] PLATFORM_STATE_STORE=memory: login state and rate limits are per-process. Never run more than one replica like this.');
    }
    return 'memory';
  }
  if (explicit === 'redis') return 'redis';
  return process.env.NODE_ENV === 'test' ? 'memory' : 'redis';
}

/** Prefix a logical key name with the API namespace. */
export function redisKey(name: string): string {
  return `${REDIS_KEY_PREFIX}${name}`;
}

/** Password for the API ACL user, derived from the platform Redis password (no extra secret). */
export function deriveApiRedisPassword(adminPassword: string): string {
  return crypto.createHmac('sha256', adminPassword).update('plat-api-redis-acl-v1').digest('hex');
}

/**
 * ACL SETUSER arguments for the API user: its key and channel space is `plat:api:*` and it
 * cannot run admin/dangerous commands. Passwords are added (not reset) so a replica still
 * running with a pre-rotation password keeps working until it restarts.
 */
export function buildApiAclSetUserArgs(username: string, password: string): string[] {
  return [
    'SETUSER', username, 'on', `>${password}`,
    'resetkeys', `~${REDIS_KEY_PREFIX}*`,
    'resetchannels', `&${REDIS_KEY_PREFIX}*`,
    '-@all', '+@read', '+@write', '+@string', '+@keyspace', '+@scripting', '+@pubsub', '+@connection',
    '-@admin', '-@dangerous', '+info', '+ping', '+client|setname',
  ];
}

function connectionBase(): RedisOptions {
  return {
    host: process.env.REDIS_HOST || 'redis-master.databases.svc.cluster.local',
    port: Number(process.env.REDIS_PORT) || 6379,
    db: Number(process.env.REDIS_DB) || 0,
    connectTimeout: 5000,
    // Fail a command quickly instead of queueing it for minutes during an outage.
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  };
}

async function ensureAclUser(adminPassword: string, username: string, password: string): Promise<'ok' | 'unsupported'> {
  const admin = new Redis({ ...connectionBase(), password: adminPassword, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  admin.on('error', () => {});
  try {
    await admin.connect(); // connection failures propagate: Redis is down, not ACL-less
    try {
      await admin.call('ACL', ...buildApiAclSetUserArgs(username, password));
      return 'ok';
    } catch (err: any) {
      console.warn(`[redis] could not create ACL user ${username} (${err?.message || err}); using the default user`);
      return 'unsupported';
    }
  } finally {
    admin.disconnect();
  }
}

let lastAclRepair = 0;

async function createClient(): Promise<Redis> {
  const adminPassword = process.env.REDIS_PASSWORD || '';
  const explicitUser = process.env.REDIS_API_USERNAME;
  const explicitPass = process.env.REDIS_API_PASSWORD;
  let auth: { username?: string; password?: string } = {};

  if (explicitUser && explicitPass) {
    auth = { username: explicitUser, password: explicitPass };
  } else if (adminPassword) {
    const apiPassword = deriveApiRedisPassword(adminPassword);
    const acl = await ensureAclUser(adminPassword, API_REDIS_USER, apiPassword);
    auth = acl === 'ok' ? { username: API_REDIS_USER, password: apiPassword } : { password: adminPassword };
  }

  const c = new Redis({ ...connectionBase(), ...auth, connectionName: 'platform-api' });
  c.on('error', (err: any) => {
    const msg = String(err?.message || err);
    // Redis restarted without an ACL file → our user is gone; recreate it (debounced) and let
    // ioredis' reconnect loop pick it up.
    // The admin password is re-read so a rotation (secret-rotate.ts) does not break the repair.
    const currentAdmin = process.env.REDIS_PASSWORD || adminPassword;
    if (/WRONGPASS|NOAUTH|NOPERM/.test(msg) && auth.username === API_REDIS_USER && currentAdmin && Date.now() - lastAclRepair > 5000) {
      lastAclRepair = Date.now();
      ensureAclUser(currentAdmin, API_REDIS_USER, auth.password!).catch(() => {});
    }
    console.warn(`[redis] ${msg}`);
  });
  return c;
}

/** The shared client. Rejects (and retries on the next call) if Redis cannot be reached. */
export function getRedis(): Promise<Redis> {
  if (testClient) return Promise.resolve(testClient);
  if (!clientPromise) {
    clientPromise = createClient().then(
      (c) => { client = c; return c; },
      (err) => { clientPromise = null; throw err; },
    );
  }
  return clientPromise;
}

/** A second connection for SUBSCRIBE (a subscribed connection cannot run other commands). */
export async function getRedisSubscriber(): Promise<Redis> {
  if (subscriber) return subscriber;
  const base = await getRedis();
  subscriber = base.duplicate({ connectionName: 'platform-api-sub' } as RedisOptions);
  subscriber.on('error', () => {});
  return subscriber;
}

/** Run a Redis operation with a deadline; any failure becomes {@link StateStoreUnavailableError}. */
export async function withRedis<T>(fn: (r: Redis) => Promise<T>, timeoutMs = REDIS_OP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const op = getRedis().then(fn);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`redis operation timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([op, deadline]);
  } catch (err: any) {
    if (err instanceof StateStoreUnavailableError) throw err;
    throw new StateStoreUnavailableError(`Session store unavailable: ${err?.message || err}`, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Readiness check: `skipped` in memory mode, otherwise PING within the op timeout. */
export async function pingRedis(): Promise<'ok' | 'skipped' | string> {
  if (stateBackend() === 'memory') return 'skipped';
  try {
    const pong = await withRedis((r) => r.ping());
    return pong === 'PONG' ? 'ok' : `unexpected reply: ${pong}`;
  } catch (err: any) {
    return err?.message || 'unavailable';
  }
}

/** Close all API Redis connections (graceful shutdown). */
export async function closeRedis(): Promise<void> {
  const conns = [subscriber, client].filter((c): c is Redis => !!c);
  subscriber = null;
  client = null;
  clientPromise = null;
  await Promise.all(conns.map((c) => c.quit().catch(() => c.disconnect())));
}

/** Tests only: route every Redis call to `c` (e.g. an ioredis-mock instance); null resets. */
export function setRedisClientForTests(c: Redis | null): void {
  testClient = c;
  subscriber = null;
}
