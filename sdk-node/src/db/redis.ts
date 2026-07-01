import Redis from 'ioredis';

export class RedisManager {
  private client: Redis | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private config: any;

  constructor(config: any = {}) {
    this.config = {
      host: config.host || process.env.PLATFORM_REDIS_HOST || 'localhost',
      port: config.port || parseInt(process.env.PLATFORM_REDIS_PORT || '6379', 10),
      password: config.password || process.env.PLATFORM_REDIS_PASSWORD || undefined,
    };
  }

  async connect(): Promise<void> {
    try {
      this.client = new Redis({ ...this.config, lazyConnect: true });
      await this.client.connect();
      this.connected = true;
      this.retryCount = 0;
      console.log('[platform] Redis connected');
    } catch (err: any) {
      console.error('[platform] Redis connection failed:', err.message);
      this.connected = false;
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

  private scheduleReconnect(): void {
    if (this.retryCount >= this.maxRetries) return;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.connected = false;
      console.log('[platform] Redis disconnected');
    }
  }

  get isConnected(): boolean { return this.connected; }
  get health(): { connected: boolean } {
    return { connected: this.connected };
  }
}
