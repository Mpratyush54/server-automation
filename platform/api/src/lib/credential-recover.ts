import { Client } from 'pg';
import Redis from 'ioredis';
import { reconnectPostgres } from '../config/database';
import { deleteSecret, patchSecretData, readSecretData, upsertSecretData } from './k8s';

export const ROTATE_PENDING_NS = 'platform';
export const ROTATE_PENDING_SECRET = 'platform-rotate-pending';

export type RecoverResult = {
  ok: boolean;
  password?: string;
  detail: string;
  source?: string;
};

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

async function readSecret(namespace: string, name: string): Promise<Record<string, string>> {
  try {
    return await readSecretData(namespace, name);
  } catch {
    return {};
  }
}

function postgresConnectOpts(password: string) {
  return {
    host: process.env.POSTGRES_HOST || 'postgresql.databases.svc.cluster.local',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password,
    database: process.env.POSTGRES_DB || 'platform',
    connectionTimeoutMillis: 8000,
  };
}

export async function canConnectPostgres(password: string): Promise<boolean> {
  const client = new Client(postgresConnectOpts(password));
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function canConnectRedis(password: string): Promise<boolean> {
  const client = new Redis({
    host: process.env.REDIS_HOST || 'redis-master.databases.svc.cluster.local',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: password || undefined,
    connectTimeout: 4000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

export async function writeRotatePending(fields: Record<string, string>): Promise<void> {
  await upsertSecretData(ROTATE_PENDING_NS, ROTATE_PENDING_SECRET, fields);
}

export async function clearRotatePending(): Promise<void> {
  await deleteSecret(ROTATE_PENDING_NS, ROTATE_PENDING_SECRET);
}

async function collectPostgresCandidates(): Promise<Array<{ password: string; source: string }>> {
  const pending = await readSecret(ROTATE_PENDING_NS, ROTATE_PENDING_SECRET);
  const envSecret = await readSecret('platform', 'platform-env');
  const pgSecret = await readSecret('databases', 'postgresql');
  const labeled = [
    { password: process.env.POSTGRES_PASSWORD || '', source: 'env' },
    { password: pending.POSTGRES_PASSWORD_NEW || '', source: 'pending-new' },
    { password: pending.POSTGRES_PASSWORD_OLD || '', source: 'pending-old' },
    { password: envSecret.POSTGRES_PASSWORD || '', source: 'platform-env' },
    { password: pgSecret['postgres-password'] || '', source: 'postgresql-secret' },
    { password: pgSecret.password || '', source: 'postgresql-secret-password' },
  ];
  const seen = new Set<string>();
  const out: Array<{ password: string; source: string }> = [];
  for (const item of labeled) {
    if (!item.password || seen.has(item.password)) continue;
    seen.add(item.password);
    out.push(item);
  }
  return out;
}

async function collectRedisCandidates(): Promise<Array<{ password: string; source: string }>> {
  const pending = await readSecret(ROTATE_PENDING_NS, ROTATE_PENDING_SECRET);
  const envSecret = await readSecret('platform', 'platform-env');
  const redisSecret = await readSecret('databases', 'redis');
  const labeled = [
    { password: process.env.REDIS_PASSWORD || '', source: 'env' },
    { password: pending.REDIS_PASSWORD_NEW || '', source: 'pending-new' },
    { password: pending.REDIS_PASSWORD_OLD || '', source: 'pending-old' },
    { password: envSecret.REDIS_PASSWORD || '', source: 'platform-env' },
    { password: redisSecret['redis-password'] || '', source: 'redis-secret' },
  ];
  const seen = new Set<string>();
  const out: Array<{ password: string; source: string }> = [];
  for (const item of labeled) {
    if (!item.password || seen.has(item.password)) continue;
    seen.add(item.password);
    out.push(item);
  }
  return out;
}

async function syncPostgresSecrets(password: string): Promise<void> {
  process.env.POSTGRES_PASSWORD = password;
  try {
    await patchSecretData('platform', 'platform-env', { POSTGRES_PASSWORD: password });
  } catch (err: any) {
    console.warn(`[credential-recover] platform-env postgres sync failed: ${err?.message || err}`);
  }
  try {
    await patchSecretData('databases', 'postgresql', {
      'postgres-password': password,
      password,
    });
  } catch (err: any) {
    console.warn(`[credential-recover] postgresql secret sync failed: ${err?.message || err}`);
  }
}

async function syncRedisSecrets(password: string): Promise<void> {
  process.env.REDIS_PASSWORD = password;
  try {
    await patchSecretData('platform', 'platform-env', { REDIS_PASSWORD: password });
  } catch (err: any) {
    console.warn(`[credential-recover] platform-env redis sync failed: ${err?.message || err}`);
  }
  try {
    await patchSecretData('databases', 'redis', { 'redis-password': password });
  } catch (err: any) {
    console.warn(`[credential-recover] redis secret sync failed: ${err?.message || err}`);
  }
}

/**
 * If the API cannot authenticate to Postgres, try every password copy we
 * still have (env, rotate-pending, platform-env, Bitnami postgresql secret),
 * reconnect TypeORM, and write the working password back to the live secrets.
 * Does not ALTER USER — the working password is the source of truth.
 */
export async function recoverPostgresAuth(): Promise<RecoverResult> {
  const candidates = await collectPostgresCandidates();
  if (candidates.length === 0) {
    return { ok: false, detail: 'no postgres password candidates' };
  }
  for (const candidate of candidates) {
    if (!(await canConnectPostgres(candidate.password))) continue;
    await reconnectPostgres(candidate.password);
    await syncPostgresSecrets(candidate.password);
    console.log(`[credential-recover] postgres auth recovered from ${candidate.source}`);
    return {
      ok: true,
      password: candidate.password,
      source: candidate.source,
      detail: `reconnected using ${candidate.source}`,
    };
  }
  return { ok: false, detail: `tried ${candidates.length} postgres password candidate(s); none worked` };
}

/**
 * Same idea for Redis WRONGPASS: try stored copies, then sync secrets to the
 * working password. Safe to call on boot; no-ops when env already works.
 */
export async function recoverRedisAuth(): Promise<RecoverResult> {
  const envPassword = process.env.REDIS_PASSWORD || '';
  if (envPassword && (await canConnectRedis(envPassword))) {
    return { ok: true, password: envPassword, source: 'env', detail: 'redis env password already works' };
  }
  const candidates = await collectRedisCandidates();
  for (const candidate of candidates) {
    if (!(await canConnectRedis(candidate.password))) continue;
    await syncRedisSecrets(candidate.password);
    console.log(`[credential-recover] redis auth recovered from ${candidate.source}`);
    return {
      ok: true,
      password: candidate.password,
      source: candidate.source,
      detail: `redis reconnected using ${candidate.source}`,
    };
  }
  return { ok: false, detail: `tried ${Math.max(candidates.length, uniqueNonEmpty([envPassword]).length)} redis password candidate(s); none worked` };
}
