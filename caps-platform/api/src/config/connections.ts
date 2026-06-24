import { Pool, PoolConfig } from 'pg';
import mongoose, { Connection } from 'mongoose';
import Redis from 'ioredis';

export interface DbHealthResult {
  type: string;
  status: 'connected' | 'degraded' | 'disconnected';
  latencyMs: number;
  error?: string;
  details?: Record<string, any>;
}

export interface ConnectionConfig {
  postgres?: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize?: number;
  };
  mongo?: {
    uri: string;
    poolSize?: number;
  };
  redis?: {
    host: string;
    port: number;
    password?: string;
    db?: number;
  };
}

class PostgresConnection {
  private pool: Pool | null = null;
  private config: ConnectionConfig['postgres'] | null = null;
  private connected = false;

  async connect(config: ConnectionConfig['postgres']): Promise<void> {
    this.config = config;
    try {
      const poolConfig: PoolConfig = {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        max: config.poolSize || 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      };

      this.pool = new Pool(poolConfig);
      await this.pool.query('SELECT 1');
      this.connected = true;
      console.log(`[db] PostgreSQL connected to ${config.host}:${config.port}/${config.database}`);
    } catch (err: any) {
      this.connected = false;
      throw new Error(`PostgreSQL connection failed: ${err.message}`);
    }
  }

  async healthCheck(): Promise<DbHealthResult> {
    const start = Date.now();
    if (!this.pool || !this.connected) {
      return { type: 'postgres', status: 'disconnected', latencyMs: 0, error: 'Not connected' };
    }

    try {
      await this.pool.query('SELECT 1');
      const latency = Date.now() - start;
      const stats = await this.pool.query(`
        SELECT
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_connections,
          (SELECT count(*) FROM pg_stat_activity WHERE state = 'idle') as idle_connections,
          (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
      `);

      return {
        type: 'postgres',
        status: latency > 1000 ? 'degraded' : 'connected',
        latencyMs: latency,
        details: {
          activeConnections: parseInt(stats.rows[0].active_connections),
          idleConnections: parseInt(stats.rows[0].idle_connections),
          maxConnections: parseInt(stats.rows[0].max_connections),
          poolSize: this.config?.poolSize || 10,
        },
      };
    } catch (err: any) {
      return { type: 'postgres', status: 'disconnected', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async query(text: string, params?: any[]): Promise<any> {
    if (!this.pool) throw new Error('PostgreSQL not connected');
    return this.pool.query(text, params);
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
      console.log('[db] PostgreSQL disconnected');
    }
  }

  get isConnected(): boolean { return this.connected; }
}

class MongoConnection {
  private conn: Connection | null = null;
  private config: ConnectionConfig['mongo'] | null = null;

  async connect(config: ConnectionConfig['mongo']): Promise<void> {
    this.config = config;
    try {
      this.conn = await mongoose.createConnection(config.uri, {
        maxPoolSize: config.poolSize || 5,
        serverSelectionTimeoutMS: 5000,
      }).asPromise();
      console.log(`[db] MongoDB connected to ${config.uri}`);
    } catch (err: any) {
      throw new Error(`MongoDB connection failed: ${err.message}`);
    }
  }

  async healthCheck(): Promise<DbHealthResult> {
    const start = Date.now();
    if (!this.conn) {
      return { type: 'mongo', status: 'disconnected', latencyMs: 0, error: 'Not connected' };
    }

    try {
      await this.conn.db?.command({ ping: 1 });
      const latency = Date.now() - start;
      const stats = await this.conn.db?.command({ serverStatus: 1 });

      return {
        type: 'mongo',
        status: latency > 1000 ? 'degraded' : 'connected',
        latencyMs: latency,
        details: {
          connections: stats?.connections?.current || 0,
          available: stats?.connections?.available || 0,
          opcounters: stats?.opcounters || {},
        },
      };
    } catch (err: any) {
      return { type: 'mongo', status: 'disconnected', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async disconnect(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
      console.log('[db] MongoDB disconnected');
    }
  }

  get isConnected(): boolean { return this.conn !== null; }
  get connection(): Connection | null { return this.conn; }
}

class RedisConnection {
  private client: Redis | null = null;
  private config: ConnectionConfig['redis'] | null = null;

  async connect(config: ConnectionConfig['redis']): Promise<void> {
    this.config = config;
    try {
      this.client = new Redis({
        host: config.host,
        port: config.port,
        password: config.password,
        db: config.db || 0,
        lazyConnect: true,
        connectTimeout: 5000,
        retryStrategy(times: number) {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      });

      await this.client.connect();
      console.log(`[db] Redis connected to ${config.host}:${config.port}`);
    } catch (err: any) {
      throw new Error(`Redis connection failed: ${err.message}`);
    }
  }

  async healthCheck(): Promise<DbHealthResult> {
    const start = Date.now();
    if (!this.client) {
      return { type: 'redis', status: 'disconnected', latencyMs: 0, error: 'Not connected' };
    }

    try {
      await this.client.ping();
      const latency = Date.now() - start;
      const info = await this.client.info('memory');
      const memUsed = info.match(/used_memory:(\d+)/)?.[1] || '0';
      const memPeak = info.match(/used_memory_peak:(\d+)/)?.[1] || '0';

      return {
        type: 'redis',
        status: latency > 1000 ? 'degraded' : 'connected',
        latencyMs: latency,
        details: {
          usedMemory: parseInt(memUsed),
          peakMemory: parseInt(memPeak),
        },
      };
    } catch (err: any) {
      return { type: 'redis', status: 'disconnected', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async get(key: string): Promise<string | null> {
    return this.client?.get(key) || null;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    if (!this.client) return;
    if (ttl) await this.client.setex(key, ttl, value);
    else await this.client.set(key, value);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      console.log('[db] Redis disconnected');
    }
  }

  get isConnected(): boolean { return this.client !== null && this.client.status === 'ready'; }
}

// Singleton instances
export const postgres = new PostgresConnection();
export const mongo = new MongoConnection();
export const redis = new RedisConnection();

export async function connectAll(config: ConnectionConfig): Promise<void> {
  const results: string[] = [];

  if (config.postgres) {
    try {
      await postgres.connect(config.postgres);
      results.push('PostgreSQL: connected');
    } catch (err: any) {
      results.push(`PostgreSQL: ${err.message}`);
    }
  }

  if (config.mongo) {
    try {
      await mongo.connect(config.mongo);
      results.push('MongoDB: connected');
    } catch (err: any) {
      results.push(`MongoDB: ${err.message}`);
    }
  }

  if (config.redis) {
    try {
      await redis.connect(config.redis);
      results.push('Redis: connected');
    } catch (err: any) {
      results.push(`Redis: ${err.message}`);
    }
  }

  console.log('[db] Connection results:', results.join(', '));
}

export async function healthCheckAll(): Promise<DbHealthResult[]> {
  const results: DbHealthResult[] = [];

  if (postgres.isConnected) results.push(await postgres.healthCheck());
  if (mongo.isConnected) results.push(await mongo.healthCheck());
  if (redis.isConnected) results.push(await redis.healthCheck());

  return results;
}

export async function disconnectAll(): Promise<void> {
  await Promise.allSettled([
    postgres.disconnect(),
    mongo.disconnect(),
    redis.disconnect(),
  ]);
}
