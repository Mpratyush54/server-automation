import Redis from 'ioredis';
import { redisEndpointOptions, redisSentinelConfig } from './redis-endpoint';

/**
 * Shared Redis connection for coordination (locks, idempotency). Uses the platform Redis
 * (REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_SENTINEL_*, same variables platformctl injects),
 * falling back to PLATFORM_REDIS_* for single-host. Disabled when neither host nor Sentinel is set
 * or COORDINATION_BACKEND=memory|postgres.
 *
 * Commands fail fast (no offline queue) so callers can fall back to Postgres when Redis is down.
 */
let client: Redis | null = null;
let clientPassword: string | undefined;
let override: Redis | null | undefined;

export function coordinationRedisConfigured(): boolean {
  if (override !== undefined) return override !== null;
  const backend = (process.env.COORDINATION_BACKEND || '').toLowerCase();
  if (backend === 'memory' || backend === 'postgres') return false;
  return !!(process.env.REDIS_HOST || process.env.PLATFORM_REDIS_HOST || process.env.REDIS_SENTINEL_HOSTS);
}

function currentPassword(): string | undefined {
  return process.env.REDIS_PASSWORD || process.env.PLATFORM_REDIS_PASSWORD || undefined;
}

function createClient(): Redis {
  const sentinel = redisSentinelConfig();
  let endpoint = sentinel
    ? redisEndpointOptions()
    : redisEndpointOptions({ defaultHost: process.env.PLATFORM_REDIS_HOST });
  // Single-host: keep PLATFORM_REDIS_* port fallback when REDIS_PORT is unset.
  if (!sentinel) {
    endpoint = {
      ...endpoint,
      host: process.env.REDIS_HOST || process.env.PLATFORM_REDIS_HOST || endpoint.host,
      port: parseInt(process.env.REDIS_PORT || process.env.PLATFORM_REDIS_PORT || String(endpoint.port || 6379), 10),
    };
  }
  const c = new Redis({
    ...endpoint,
    password: currentPassword(),
    db: parseInt(process.env.PLATFORM_REDIS_DB || '0', 10),
    connectTimeout: 3000,
    commandTimeout: 3000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Keep reconnecting in the background with capped backoff; callers fall back meanwhile.
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  });
  c.on('error', (err) => {
    // Rotation changes REDIS_PASSWORD; drop the client so the next call reconnects with it.
    if (/WRONGPASS|NOAUTH/i.test(err?.message || '')) {
      if (client === c) client = null;
      c.disconnect();
    }
  });
  return c;
}

/**
 * The coordination Redis client when configured and connected, otherwise null.
 * Never throws; a null return means "use the fallback backend".
 */
export function getCoordinationRedis(): Redis | null {
  if (override !== undefined) return override;
  if (!coordinationRedisConfigured()) return null;
  const pw = currentPassword();
  if (client && clientPassword !== pw && client.status !== 'ready') {
    client.disconnect();
    client = null;
  }
  if (!client) {
    try {
      client = createClient();
      clientPassword = pw;
    } catch {
      client = null;
      return null;
    }
  }
  return client.status === 'ready' ? client : null;
}

/** Test hook: force a specific client (or null for "Redis unavailable"); undefined resets. */
export function setCoordinationRedisForTests(c: Redis | null | undefined): void {
  override = c;
}

export async function closeCoordinationRedis(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    await c.quit().catch(() => c.disconnect());
  }
}

/**
 * Like getCoordinationRedis, but waits briefly for a connection that is still being
 * established (first use after boot, or a reconnect) instead of falling back immediately.
 */
export async function readyCoordinationRedis(waitMs = 1500): Promise<Redis | null> {
  const ready = getCoordinationRedis();
  if (ready || override !== undefined || !client) return ready;
  const c = client;
  // Only wait for a first connection; while Redis is down ('reconnecting') fall back at once.
  if (!['wait', 'connecting', 'connect'].includes(c.status)) return null;
  return new Promise<Redis | null>((resolve) => {
    const done = (v: Redis | null) => {
      clearTimeout(timer);
      c.off('ready', onReady);
      resolve(v);
    };
    const onReady = () => done(c);
    const timer = setTimeout(() => done(c.status === 'ready' ? c : null), waitMs);
    (timer as any).unref?.();
    c.once('ready', onReady);
  });
}
