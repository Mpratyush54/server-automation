import { Pool } from 'pg';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { Project } from '../entities/Project';
import { projectDbIdentity } from './project-db-identity';
import { publishAlertEvent } from './alert-events';

export const monitoringEnabled = () => process.env.PLATFORM_OBSERVABILITY === 'enabled';
export const slowMs = () => Math.min(60000, Math.max(10, Number(process.env.DATABASE_SLOW_MS) || 100));

// Fail closed for utility statements: pg_stat_statements does not normalize all DDL.
// Keep only a SQL token vocabulary; identifiers and all literal forms become placeholders.
export function safeSql(query: string): string {
  const words = new Set('select from where and or join left right inner outer on as insert into values update set delete returning order by group having limit offset asc desc distinct count sum avg min max with union all is null not in exists like between case when then else end'.split(' '));
  if (!/^\s*(select|insert|update|delete|with)\b/i.test(query)) return '[utility statement]';
  return query.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([a-zA-Z_][a-zA-Z_0-9]*|)\$[\s\S]*?\$\1\$/g, '?')
    .replace(/'(?:''|\\.|[^'\\])*'|"(?:""|[^"])*"/g, '?')
    .match(/[a-zA-Z_][a-zA-Z_0-9]*|\$\d+|[(),.*=<>+/-]|\d+(?:\.\d+)?|\?/g)
    ?.map(t => words.has(t.toLowerCase()) ? t.toUpperCase() : /^[(),.*=<>+/-]$/.test(t) ? t : '?').join(' ').slice(0, 2000) || '[statement]';
}

export function mongoOperation(row: any, dbName: string) {
  if (typeof row.ns !== 'string' || !row.ns.startsWith(dbName + '.')) return null;
  const operation = ['query', 'command', 'insert', 'update', 'remove', 'getmore'].includes(row.op) ? row.op : 'operation';
  // Never serialize command/filter/documents, collection names or error text.
  return { query: `${operation} { … }`, latencyMs: Number(row.millis) || 0,
    rows: Number(row.nreturned) || 0, at: row.ts instanceof Date ? row.ts.toISOString() : undefined };
}

export async function postgresInsights(dbName: string, username: string) {
  const pool = new Pool({ host: process.env.POSTGRES_HOST || 'localhost', port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || 'postgres', password: process.env.POSTGRES_PASSWORD,
    database: dbName, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  try {
    // Also initializes databases provisioned before monitoring was enabled.
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    const stats = await pool.query(`SELECT pg_database_size($1)::float8 AS "sizeBytes",
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=$1 AND usename=$2) AS connections`, [dbName, username]);
    const top = await pool.query(`SELECT queryid::text AS id, query, calls::float8 AS calls, rows::float8 AS rows,
      mean_exec_time AS "latencyMs", total_exec_time AS "totalMs"
      FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=$1)
      AND userid=(SELECT oid FROM pg_roles WHERE rolname=$2)
      ORDER BY total_exec_time DESC LIMIT 20`, [dbName, username]);
    return { ...stats.rows[0], topQueries: top.rows.map(r => ({ ...r, query: safeSql(r.query) })) };
  } finally { await pool.end(); }
}

async function mongoInsights(dbName: string) {
  // Replica-set URI → driver talks to the primary. `profile` is per member and is re-applied
  // on the current primary on each collection, so per-project profiling survives failover.
  const conn = mongoose.createConnection(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/plat_platform', { serverSelectionTimeoutMS: 3000 });
  conn.on('error', () => {});
  try {
    await conn.asPromise();
    const db = conn.getClient().db(dbName);
    const userInfo = await db.command({ usersInfo: `${dbName}_user`, maxTimeMS: 5000 });
    if (!userInfo.users?.length) return { status: 'not-provisioned' };
    await db.command({ profile: 1, slowms: slowMs() });
    const stats = await db.command({ dbStats: 1, maxTimeMS: 5000 });
    const rows = await db.collection('system.profile').find({ ns: { $regex: '^' + dbName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.' }, millis: { $gte: slowMs() }, ts: { $gte: new Date(Date.now() - 3600000) } })
      .sort({ millis: -1 }).limit(20).maxTimeMS(5000).toArray();
    return { sizeBytes: stats.dataSize, slowQueries: rows.map(r => mongoOperation(r, dbName)).filter(Boolean), windowMinutes: 60 };
  } finally { await conn.close().catch(() => {}); }
}

async function redisInsights(prefix: string) {
  const { redisEndpointOptions } = await import('./redis-endpoint');
  // SCAN runs on the master (Sentinel role: 'master' or single host).
  const client = new Redis({
    ...redisEndpointOptions({ defaultHost: 'localhost' }),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    let cursor = '0'; const keys = new Set<string>(); let iterations = 0;
    const deadline = Date.now() + 1000;
    do {
      const page = await client.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 200);
      cursor = page[0]; page[1].filter(k => k.startsWith(prefix)).forEach(k => keys.add(k));
    } while (cursor !== '0' && ++iterations < 25 && Date.now() < deadline);
    return { keyCount: keys.size, complete: cursor === '0', scope: 'project key prefix', connections: null };
  } finally { client.disconnect(); }
}

// Bounded per-process cache coalesces expensive reads and limits alert publication.
const cache = new Map<string, { expires: number; value: Promise<any> }>();
export function databaseInsights(project: Project, environment: string): Promise<any> {
  const key = `${project.id}:${environment}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  const value = collect(project, environment);
  cache.set(key, { expires: Date.now() + 30000, value });
  return value;
}

async function collect(project: Project, environment: string) {
  const { id, env } = projectDbIdentity(project.id, environment);
  const identity = Object.prototype.hasOwnProperty.call(project.databaseResources || {}, environment) ? project.databaseResources![environment] : undefined;
  const result: any = { enabled: true, environment, collectedAt: new Date().toISOString(), slowMs: slowMs() };
  const sources: Record<string, () => Promise<any>> = {
    postgres: () => {
      if (!identity) return Promise.resolve({ status: 'not-provisioned' });
      if (['postgres', 'template0', 'template1', process.env.POSTGRES_DB || 'plat_platform'].includes(identity.dbName)
        || identity.username === (process.env.POSTGRES_USER || 'postgres')) return Promise.resolve({ status: 'unavailable' });
      return postgresInsights(identity.dbName, identity.username);
    },
    mongo: () => mongoInsights(`plat_${id}_${env}`), redis: () => redisInsights(`plat:${id}:${env}:`),
  };
  await Promise.all(Object.entries(sources).map(async ([name, read]) => {
    try { result[name] = { status: 'ready', ...await read() }; }
    catch { result[name] = { status: 'unavailable' }; } // Driver errors can contain credentials/query values.
  }));
  const slow = result.mongo.slowQueries?.length || result.postgres.topQueries?.some((q: any) => q.latencyMs >= slowMs());
  if (slow || (result.mongo.status === 'ready' && result.postgres.status === 'ready')) await publishAlertEvent({ projectId: project.id, environment, source: 'database', severity: 'warning',
    dedupeKey: `database:slow:${environment}`, status: slow ? 'firing' : 'resolved', title: 'Database slow queries',
    url: `/projects/${project.id}?tab=databases` });
  return result;
}
