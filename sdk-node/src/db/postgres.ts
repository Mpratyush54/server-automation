import type { Pool, PoolClient, QueryResult } from 'pg';

export class PostgresManager {
  private pool: Pool | null = null;
  private connected = false;
  private retryCount = 0;
  private maxRetries = 5;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private config: any;

  constructor(config: any = {}) {
    this.config = {
      host: config.host || process.env.PLATFORM_PG_HOST || 'localhost',
      port: config.port || parseInt(process.env.PLATFORM_PG_PORT || '5432', 10),
      user: config.user || process.env.PLATFORM_PG_USER || 'platform',
      // No default password: credentials must come from the Platform or the environment.
      password: config.password || process.env.PLATFORM_PG_PASSWORD || undefined,
      database: config.database || process.env.PLATFORM_PG_DB || 'platform',
      max: config.poolSize || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  async connect(): Promise<void> {
    if (!this.config.password) {
      // Fail closed instead of silently trying a well-known password.
      throw new Error(
        '[platform] PostgreSQL credentials missing: no password from Platform db-credentials ' +
        'and PLATFORM_PG_PASSWORD is not set'
      );
    }
    this.stopped = false;
    this.clearReconnectTimer();
    // Dispose any pool left over from a previous (failed) attempt before creating a new one.
    await this.disposePool();
    const { Pool } = require('pg');
    const pool: Pool = new Pool(this.config);
    pool.on('error', (err: Error) => {
      console.error('[platform] PostgreSQL error:', err.message);
    });
    this.pool = pool;
    try {
      await pool.query('SELECT 1');
      this.connected = true;
      this.retryCount = 0;
      console.log('[platform] PostgreSQL connected');
    } catch (err: any) {
      console.error('[platform] PostgreSQL connection failed:', err.message);
      this.connected = false;
      await this.disposePool();
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

  private async disposePool(): Promise<void> {
    const old = this.pool;
    this.pool = null;
    if (old) {
      try { await old.end(); } catch {}
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
    if (this.pool) {
      await this.disposePool();
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
