import { Pool, PoolClient, QueryResult } from 'pg';

export class PostgresManager {
  private pool: Pool | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private config: any;

  constructor(config: any = {}) {
    this.config = {
      host: config.host || process.env.PLATFORM_PG_HOST || 'localhost',
      port: config.port || parseInt(process.env.PLATFORM_PG_PORT || '5432', 10),
      user: config.user || process.env.PLATFORM_PG_USER || 'platform',
      password: config.password || process.env.PLATFORM_PG_PASSWORD || 'platform',
      database: config.database || process.env.PLATFORM_PG_DB || 'platform',
      max: config.poolSize || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  async connect(): Promise<void> {
    try {
      this.pool = new Pool(this.config);
      await this.pool.query('SELECT 1');
      this.connected = true;
      this.retryCount = 0;
      console.log('[platform] PostgreSQL connected');
    } catch (err: any) {
      console.error('[platform] PostgreSQL connection failed:', err.message);
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  async query(text: string, params?: any[]): Promise<QueryResult> {
    if (!this.pool) throw new Error('PostgreSQL not connected');
    return this.pool.query(text, params);
  }

  async getClient(): Promise<PoolClient> {
    if (!this.pool) throw new Error('PostgreSQL not connected');
    return this.pool.connect();
  }

  private scheduleReconnect(): void {
    if (this.retryCount >= this.maxRetries) return;
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 30000);
    this.retryCount++;
    setTimeout(() => this.connect(), delay);
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.connected = false;
      console.log('[platform] PostgreSQL disconnected');
    }
  }

  get isConnected(): boolean { return this.connected; }
  get health(): { connected: boolean; poolSize: number } {
    return {
      connected: this.connected,
      poolSize: this.config.max,
    };
  }
}
