import type Redis from 'ioredis';

export class RedisManager {
  private client: Redis | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private config: any;

  constructor(config: any = {}) {
    this.config = {
      host: config.host || process.env.PLATFORM_REDIS_HOST || 'localhost',
      port: config.port || parseInt(process.env.PLATFORM_REDIS_PORT || '6379', 10),
      // Platform db-credentials return a per-project ACL user confined to keyPrefix.
      username: config.username || process.env.PLATFORM_REDIS_USERNAME || undefined,
      password: config.password || process.env.PLATFORM_REDIS_PASSWORD || undefined,
      keyPrefix: config.keyPrefix || process.env.PLATFORM_REDIS_KEY_PREFIX || undefined,
      db: config.db ?? (process.env.PLATFORM_REDIS_DB ? parseInt(process.env.PLATFORM_REDIS_DB, 10) : undefined),
    };
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
  get health(): { connected: boolean } {
    return { connected: this.connected };
  }
}
