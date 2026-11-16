import type Redis from 'ioredis';

function parseSentinels(value: unknown): Array<{ host: string; port: number }> | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    return value.map((s: any) => ({
      host: String(s.host ?? s[0]),
      port: Number(s.port ?? s[1] ?? 26379),
    })).filter((s) => s.host && Number.isFinite(s.port));
  }
  if (typeof value === 'string') {
    const out: Array<{ host: string; port: number }> = [];
    for (const part of value.split(',')) {
      const raw = part.trim();
      if (!raw) continue;
      const idx = raw.lastIndexOf(':');
      if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
        out.push({ host: raw.slice(0, idx), port: parseInt(raw.slice(idx + 1), 10) });
      } else {
        out.push({ host: raw, port: 26379 });
      }
    }
    return out.length ? out : undefined;
  }
  return undefined;
}

/** Reconnect + resend after a demoted master returns READONLY. */
export function redisReadonlyReconnect(err: Error): 2 | false {
  return /READONLY/.test(err?.message || '') ? 2 : false;
}

export class RedisManager {
  private client: Redis | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private config: any;
  private _mode: 'sentinel' | 'standalone';

  constructor(config: any = {}) {
    const sentinels = parseSentinels(
      config.sentinels ?? process.env.PLATFORM_REDIS_SENTINELS,
    );
    const masterName = config.masterName || config.name
      || process.env.PLATFORM_REDIS_SENTINEL_MASTER
      || (sentinels ? 'mymaster' : undefined);
    const base: any = {
      // Platform db-credentials return a per-project ACL user confined to keyPrefix.
      username: config.username || process.env.PLATFORM_REDIS_USERNAME || undefined,
      password: config.password || process.env.PLATFORM_REDIS_PASSWORD || undefined,
      keyPrefix: config.keyPrefix || process.env.PLATFORM_REDIS_KEY_PREFIX || undefined,
      db: config.db ?? (process.env.PLATFORM_REDIS_DB ? parseInt(process.env.PLATFORM_REDIS_DB, 10) : undefined),
    };
    if (sentinels?.length) {
      this._mode = 'sentinel';
      this.config = {
        ...base,
        sentinels,
        name: masterName || 'mymaster',
        sentinelUsername: config.sentinelUsername || process.env.PLATFORM_REDIS_SENTINEL_USERNAME || undefined,
        sentinelPassword: config.sentinelPassword || process.env.PLATFORM_REDIS_SENTINEL_PASSWORD || undefined,
        role: 'master',
        reconnectOnError: redisReadonlyReconnect,
      };
    } else {
      this._mode = 'standalone';
      this.config = {
        host: config.host || process.env.PLATFORM_REDIS_HOST || 'localhost',
        port: config.port || parseInt(process.env.PLATFORM_REDIS_PORT || '6379', 10),
        ...base,
      };
    }
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.clearReconnectTimer();
    // Dispose any client left over from a previous (failed) attempt before creating a new one.
    this.disposeClient();
    // Loaded lazily so OpenTelemetry's ioredis instrumentation (started first) can patch it.
    const ioredis = require('ioredis');
    const RedisCtor = (ioredis.default ?? ioredis) as typeof Redis;
    const client = new RedisCtor({ ...this.config, lazyConnect: true });
    // Without a listener ioredis re-emits connection failures as "Unhandled error event".
    client.on('error', (err: Error) => {
      if (this.client === client) this.connected = false;
      console.error('[platform] Redis error:', err.message);
    });
    // ioredis reconnects on its own after an established connection drops (Redis restart /
    // Sentinel failover); without this the manager kept reporting "disconnected" after recovery.
    client.on('ready', () => {
      if (this.client === client && !this.connected) {
        this.connected = true;
        this.retryCount = 0;
        console.log('[platform] Redis reconnected');
      }
    });
    this.client = client;
    try {
      await client.connect();
      this.connected = true;
      this.retryCount = 0;
      console.log('[platform] Redis connected');
    } catch (err: any) {
      console.error('[platform] Redis connection failed:', err.message);
      this.connected = false;
      this.disposeClient();
      this.scheduleReconnect();
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    return this.client.get(key);
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) return;
    if (ttl) await this.client.setex(key, ttl, value);
    else await this.client.set(key, value);
  }

  async del(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.del(key);
  }

  private disposeClient(): void {
    const old = this.client;
    this.client = null;
    if (old) {
      try { old.disconnect(); } catch {}
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryCount >= this.maxRetries) return;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    this.retryCount++;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {});
    }, delay);
    (this.reconnectTimer as any).unref?.();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    if (this.client) {
      const client = this.client;
      this.client = null;
      try { await client.quit(); } catch { client.disconnect(); }
      this.connected = false;
      console.log('[platform] Redis disconnected');
    }
  }

  get isConnected(): boolean { return this.connected; }
  get mode(): 'sentinel' | 'standalone' { return this._mode; }
  get health(): { connected: boolean; mode?: 'sentinel' | 'standalone' } {
    return { connected: this.connected, mode: this._mode };
  }
}
