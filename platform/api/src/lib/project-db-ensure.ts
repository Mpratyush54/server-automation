import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import { encryptValue, decryptValue } from './secrets-encryption';
import {
  generateSecurePassword,
  DbProvisionResult,
} from './database-service';
import { Pool } from 'pg';
import { Project } from '../entities/Project';
import { projectDbIdentity } from './project-db-identity';
export { projectDbIdentity } from './project-db-identity';

/**
 * Key used to encrypt NEW project secrets: SECRETS_ENCRYPTION_KEY when set. Earlier releases
 * fell back to JWT_SECRET when it was unset; that is kept so existing installs keep working,
 * but there is never a hardcoded fallback key.
 */
export function secretWriteKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.SECRETS_ENCRYPTION_KEY || env.JWT_SECRET;
  if (!key) throw new Error('SECRETS_ENCRYPTION_KEY is not configured');
  return key;
}

/**
 * Decrypt a stored project secret. Values written by earlier releases were encrypted with
 * SECRETS_ENCRYPTION_KEY or, when that was unset, JWT_SECRET: try them in that order.
 */
export function decryptStoredSecret(payload: string, env: NodeJS.ProcessEnv = process.env): string {
  const keys = Array.from(new Set([env.SECRETS_ENCRYPTION_KEY, env.JWT_SECRET].filter((k): k is string => !!k)));
  let lastErr: unknown = new Error('SECRETS_ENCRYPTION_KEY is not configured');
  for (const key of keys) {
    try {
      return decryptValue(payload, key);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function upsertSecret(
  projectId: string,
  environment: string,
  key: string,
  value: string,
): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(Secret);
  const encrypted = encryptValue(String(value), secretWriteKey());
  let secret = await repo.findOne({
    where: { projectId, environmentId: environment, key, isActive: true },
  });
  if (secret) {
    secret.encryptedValue = encrypted;
    secret.version = (secret.version || 1) + 1;
    await repo.save(secret);
  } else {
    secret = repo.create({
      projectId,
      environmentId: environment,
      key,
      encryptedValue: encrypted,
      version: 1,
      isActive: true,
      createdById: null,
    });
    await repo.save(secret);
  }
}

async function readSecrets(projectId: string, environment: string): Promise<Record<string, string>> {
  try {
    const ds = await getDb();
    const secrets = await ds.getRepository(Secret).find({
      where: { projectId, environmentId: environment, isActive: true },
    });
    const out: Record<string, string> = {};
    for (const s of secrets) {
      try {
        out[s.key] = decryptStoredSecret(s.encryptedValue);
      } catch {}
    }
    return out;
  } catch {
    return {};
  }
}

export interface PostgresIdentity {
  dbName: string;
  username: string;
  password: string;
  host: string;
  port: number;
}

function adminPool(): Pool {
  return new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: 'postgres',
    max: 2,
  });
}

/**
 * Resolve the stable, id-based database identity for a project environment (recording it on
 * the project the first time) and the password to use (the stored one, or a new one).
 */
export async function resolvePostgresIdentity(projectId: string, environment: string): Promise<PostgresIdentity> {
  const existing = await readSecrets(projectId, environment);
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = parseInt(process.env.POSTGRES_PORT || '5432', 10);

  const ds = await getDb();
  const repo = ds.getRepository(Project);
  const project = await repo.findOne({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');
  let identity = project.databaseResources && Object.prototype.hasOwnProperty.call(project.databaseResources, environment) ? project.databaseResources[environment] : undefined;
  if (!identity) {
    if (existing.POSTGRES_DB || existing.POSTGRES_USER) {
      throw new Error('Legacy database identity requires administrator migration to projects.database_resources');
    }
    const { id, env } = projectDbIdentity(projectId, environment);
    identity = { dbName: `plat_${id}_${env}`, username: `plat_${id}_${env}_user` };
    project.databaseResources = { ...(project.databaseResources || {}), [environment]: identity };
    await repo.save(project);
  }
  const { dbName, username } = identity;
  if (username === (process.env.POSTGRES_USER || 'postgres') || dbName === (process.env.POSTGRES_DB || 'plat_platform')) {
    throw new Error('Platform database credentials cannot be used by a project');
  }
  const password = existing.POSTGRES_PASSWORD || generateSecurePassword(32);
  return { dbName, username, password, host, port };
}

/**
 * CREATE (or ALTER) the login role, CREATE the database if missing, GRANT. Idempotent.
 * Reports which objects this call created, so a failed provisioning can drop only those.
 */
export async function applyPostgresRoleAndDatabase(identity: PostgresIdentity): Promise<{ createdRole: boolean; createdDatabase: boolean }> {
  const { dbName, username, password } = identity;
  const admin = adminPool();
  try {
    const client = await admin.connect();
    try {
      const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
      await client.query(`${role.rows.length ? 'ALTER' : 'CREATE'} ROLE ${client.escapeIdentifier(username)} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`);
      const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (!db.rows.length) await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)} OWNER ${client.escapeIdentifier(username)}`);
      await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${client.escapeIdentifier(dbName)} TO ${client.escapeIdentifier(username)}`);
      return { createdRole: !role.rows.length, createdDatabase: !db.rows.length };
    } finally { client.release(); }
  } finally { await admin.end(); }
}

/** Compensation for applyPostgresRoleAndDatabase: drop only what that call created. */
export async function dropPostgresRoleAndDatabase(
  identity: Pick<PostgresIdentity, 'dbName' | 'username'>,
  created: { createdRole?: boolean; createdDatabase?: boolean },
): Promise<void> {
  if (!created.createdRole && !created.createdDatabase) return;
  const admin = adminPool();
  try {
    const client = await admin.connect();
    try {
      if (created.createdDatabase) await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(identity.dbName)}`);
      if (created.createdRole) await client.query(`DROP ROLE IF EXISTS ${client.escapeIdentifier(identity.username)}`);
    } finally { client.release(); }
  } finally { await admin.end(); }
}

/** Ensure Postgres role+DB exist; persist credentials for SDK getDbCredentials. Idempotent. */
export async function ensurePostgresForProject(
  projectId: string,
  projectName: string,
  environment: string,
): Promise<{ status: 'ready' | 'error'; creds?: DbProvisionResult; error?: string }> {
  try {
    const identity = await resolvePostgresIdentity(projectId, environment);
    await applyPostgresRoleAndDatabase(identity);
    const creds: DbProvisionResult = { ...identity };
    await persistPostgresCreds(projectId, environment, creds);
    return { status: 'ready', creds };
  } catch (e: any) {
    return { status: 'error', error: e.message || 'Postgres provisioning failed' };
  }
}

// ── MongoDB: one user per project/environment, readWrite on that project's database only ──

const platformMongoUri = () =>
  process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/plat_platform';

export interface ParsedMongoUri {
  scheme: string;
  username?: string;
  hosts: string;
  database: string;
  params: URLSearchParams;
}

/** Minimal mongodb:// / mongodb+srv:// parser (WHATWG URL rejects multi-host seed lists). */
export function parseMongoUri(uri: string): ParsedMongoUri {
  const m = /^(mongodb(?:\+srv)?):\/\/(?:([^@/]*)@)?([^/?]+)(?:\/([^?]*))?(?:\?(.*))?$/.exec(uri.trim());
  if (!m) throw new Error('MONGODB_URI is not a valid mongodb:// URI');
  const userInfo = m[2];
  return {
    scheme: m[1],
    username: userInfo ? decodeURIComponent(userInfo.split(':')[0]) : undefined,
    hosts: m[3],
    database: decodeURIComponent(m[4] || ''),
    params: new URLSearchParams(m[5] || ''),
  };
}

/**
 * Connection string for a project user: the platform's hosts and transport options, but the
 * project's own credentials and database (authSource = that database). Platform credentials
 * and auth-mechanism overrides are never carried over.
 */
export function buildProjectMongoUri(platformUri: string, dbName: string, username: string, password: string): string {
  const parsed = parseMongoUri(platformUri);
  const params = new URLSearchParams();
  parsed.params.forEach((value, key) => {
    if (!/^(authSource|authMechanism|authMechanismProperties)$/i.test(key)) params.set(key, value);
  });
  params.set('authSource', dbName);
  return `${parsed.scheme}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${parsed.hosts}/${encodeURIComponent(dbName)}?${params.toString()}`;
}

/** createUser / updateUser command granting readWrite on exactly one database. */
export function buildMongoUserCommand(dbName: string, username: string, password: string, exists: boolean): Record<string, unknown> {
  const roles = [{ role: 'readWrite', db: dbName }];
  return exists
    ? { updateUser: username, pwd: password, roles }
    : { createUser: username, pwd: password, roles };
}

export async function ensureMongoForProject(
  projectId: string,
  projectName: string,
  environment: string,
): Promise<{ status: 'ready' | 'error'; creds?: { uri: string; database: string; username: string; password: string }; error?: string }> {
  try {
    const adminUri = platformMongoUri();
    const platform = parseMongoUri(adminUri);
    const { id, env } = projectDbIdentity(projectId, environment);
    const dbName = `plat_${id}_${env}`;
    const username = `plat_${id}_${env}_user`;
    if (dbName === platform.database || username === platform.username) {
      throw new Error('Platform database credentials cannot be used by a project');
    }
    const existing = await readSecrets(projectId, environment);
    // Reuse the stored password only when it belongs to this project user (legacy installs
    // stored a MONGO_URI with the platform's own credentials).
    const password = existing.MONGO_USER === username && existing.MONGO_PASSWORD
      ? existing.MONGO_PASSWORD
      : generateSecurePassword(32);

    const mongoose = await import('mongoose');
    const conn = mongoose.createConnection(adminUri, { serverSelectionTimeoutMS: 5000 });
    conn.on('error', () => {});
    try {
      await conn.asPromise();
      const db = conn.getClient().db(dbName);
      const info: any = await db.command({ usersInfo: username });
      const exists = Array.isArray(info?.users) && info.users.length > 0;
      await db.command(buildMongoUserCommand(dbName, username, password, exists));
      const { monitoringEnabled, slowMs } = await import('./database-insights');
      if (monitoringEnabled()) await db.command({ profile: 1, slowms: slowMs() });
    } finally {
      await conn.close().catch(() => {});
    }

    const uri = buildProjectMongoUri(adminUri, dbName, username, password);
    await upsertSecret(projectId, environment, 'MONGO_DB', dbName);
    await upsertSecret(projectId, environment, 'MONGO_USER', username);
    await upsertSecret(projectId, environment, 'MONGO_PASSWORD', password);
    await upsertSecret(projectId, environment, 'MONGO_URI', uri);
    return { status: 'ready', creds: { uri, database: dbName, username, password } };
  } catch (e: any) {
    return { status: 'error', error: e.message || 'MongoDB provisioning failed' };
  }
}

// ── Redis: one ACL user per project/environment, confined to its key/channel prefix ──

const SAFE_REDIS_TOKEN = /^[A-Za-z0-9_:-]+$/;

/**
 * Arguments for `ACL SETUSER` for a project user. `reset` first makes the call idempotent
 * (drops stale passwords/patterns from earlier runs); the user may only touch keys and pub/sub
 * channels under its prefix and gets no @admin or @dangerous commands.
 */
export function buildRedisAclSetUserArgs(username: string, password: string, keyPrefix: string): string[] {
  if (!SAFE_REDIS_TOKEN.test(username) || username === 'default') throw new Error('Invalid Redis ACL username');
  if (!SAFE_REDIS_TOKEN.test(keyPrefix)) throw new Error('Invalid Redis key prefix');
  if (!password || /\s/.test(password)) throw new Error('Invalid Redis ACL password');
  return ['SETUSER', username, 'reset', 'on', `>${password}`, `~${keyPrefix}*`, `&${keyPrefix}*`, '+@all', '-@admin', '-@dangerous'];
}

export type ProjectRedisCreds = {
  host: string;
  port: number;
  username: string;
  password: string;
  keyPrefix: string;
  sentinels?: Array<{ host: string; port: number }>;
  masterName?: string;
  sentinelUsername?: string;
  sentinelPassword?: string;
};

export async function ensureRedisForProject(
  projectId: string, projectName: string, environment: string,
): Promise<{ status: 'ready' | 'error'; creds?: ProjectRedisCreds; error?: string }> {
  try {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const { id, env } = projectDbIdentity(projectId, environment);
    const username = `plat_${id}_${env}`;
    const keyPrefix = `plat:${id}:${env}:`;
    const platformPassword = process.env.REDIS_PASSWORD || '';
    const existing = await readSecrets(projectId, environment);
    // Legacy installs copied the platform REDIS_PASSWORD into project secrets: never reuse it.
    const password = existing.REDIS_USERNAME === username && existing.REDIS_PASSWORD && existing.REDIS_PASSWORD !== platformPassword
      ? existing.REDIS_PASSWORD
      : generateSecurePassword(32);

    const {
      forEachRedisDataNode,
      redisDataNodes,
      redisSentinelConfig,
      ensureSentinelUser,
      deriveSentinelPassword,
      SENTINEL_ACL_USER,
      parseSentinelHosts,
    } = await import('./redis-endpoint');

    const nodes = await redisDataNodes(platformPassword);
    const master = nodes.find((n) => n.role === 'master') ?? nodes[0];
    const masterLabel = `${master.host}:${master.port}`;
    const aclArgs = buildRedisAclSetUserArgs(username, password, keyPrefix);
    const result = await forEachRedisDataNode(platformPassword, async (client) => {
      await client.call('ACL', ...aclArgs);
      // Persist when Redis runs with an aclfile. Without one ACL SAVE errors; the reconcile job retries.
      await Promise.resolve(client.call('ACL', 'SAVE')).catch(() => {});
    });
    if (!result.ok.includes(masterLabel)) {
      const fail = result.failed.find((f) => f.node === masterLabel) || result.failed[0];
      throw new Error(fail?.error || 'Redis ACL SETUSER failed on master');
    }
    if (result.failed.length > 0) {
      console.warn(`[redis] ACL SETUSER ok on master; replica failures (reconcile will retry): ${result.failed.map((f) => `${f.node}: ${f.error}`).join('; ')}`);
    }

    await upsertSecret(projectId, environment, 'REDIS_HOST', host);
    await upsertSecret(projectId, environment, 'REDIS_PORT', String(port));
    await upsertSecret(projectId, environment, 'REDIS_USERNAME', username);
    await upsertSecret(projectId, environment, 'REDIS_PASSWORD', password);
    await upsertSecret(projectId, environment, 'REDIS_KEY_PREFIX', keyPrefix);

    const creds: ProjectRedisCreds = { host, port, username, password, keyPrefix };
    const sentinel = redisSentinelConfig();
    if (sentinel) {
      await ensureSentinelUser(platformPassword);
      const sentinelPassword = deriveSentinelPassword(platformPassword);
      const sentinelsStr = process.env.REDIS_SENTINEL_HOSTS || sentinel.sentinels.map((s) => `${s.host}:${s.port}`).join(',');
      await upsertSecret(projectId, environment, 'REDIS_SENTINELS', sentinelsStr);
      await upsertSecret(projectId, environment, 'REDIS_SENTINEL_MASTER', sentinel.name);
      await upsertSecret(projectId, environment, 'REDIS_SENTINEL_USERNAME', SENTINEL_ACL_USER);
      await upsertSecret(projectId, environment, 'REDIS_SENTINEL_PASSWORD', sentinelPassword);
      creds.sentinels = parseSentinelHosts(sentinelsStr);
      creds.masterName = sentinel.name;
      creds.sentinelUsername = SENTINEL_ACL_USER;
      creds.sentinelPassword = sentinelPassword;
    }

    return { status: 'ready', creds };
  } catch (e: any) {
    return { status: 'error', error: e.message || 'Redis provisioning failed' };
  }
}

export async function ensureProjectDatabases(
  projectId: string,
  projectName: string,
  environment: string,
  dbTypes: string[],
): Promise<Record<string, { status: string; error?: string }>> {
  const out: Record<string, { status: string; error?: string }> = {};
  if (dbTypes.includes('postgres')) {
    const r = await ensurePostgresForProject(projectId, projectName, environment);
    out.postgres = { status: r.status, error: r.error };
  }
  if (dbTypes.includes('mongo')) {
    const r = await ensureMongoForProject(projectId, projectName, environment);
    out.mongo = { status: r.status, error: r.error };
  }
  if (dbTypes.includes('redis')) {
    const r = await ensureRedisForProject(projectId, projectName, environment);
    out.redis = { status: r.status, error: r.error };
  }
  return out;
}

/** Persist known Postgres creds for SDK resolution (idempotent upsert). */
export async function persistPostgresCreds(
  projectId: string,
  environment: string,
  creds: DbProvisionResult,
): Promise<void> {
  await upsertSecret(projectId, environment, 'POSTGRES_HOST', creds.host);
  await upsertSecret(projectId, environment, 'POSTGRES_PORT', String(creds.port));
  await upsertSecret(projectId, environment, 'POSTGRES_USER', creds.username);
  await upsertSecret(projectId, environment, 'POSTGRES_PASSWORD', creds.password);
  await upsertSecret(projectId, environment, 'POSTGRES_DB', creds.dbName);
}

/**
 * Per-project credentials for /sdk/db-credentials. Every credential belongs to this project
 * only (Postgres role, MongoDB user, Redis ACL user); platform-owned credentials are never
 * returned. A type that cannot be provisioned is reported as { status: 'error' }; when no
 * requested type could be provisioned the first error is thrown.
 */
export async function resolveProjectDbCredentials(
  projectId: string,
  projectName: string,
  environment: string,
  dbTypes: string[],
): Promise<Record<string, any>> {
  const types = dbTypes.length ? dbTypes : ['postgres', 'mongo', 'redis'];
  if (types.some(type => !['postgres', 'mongo', 'redis'].includes(type))) throw new Error('Unsupported database type');
  const result: Record<string, any> = {};
  const errors: string[] = [];
  const failed = (db: string, error: string | undefined) => {
    const message = error || `${db} credentials are unavailable`;
    errors.push(message);
    return { status: 'error', error: message };
  };

  if (types.includes('postgres')) {
    const r = await ensurePostgresForProject(projectId, projectName, environment);
    result.postgres = r.status === 'ready' && r.creds
      ? { host: r.creds.host, port: r.creds.port, user: r.creds.username,
        password: r.creds.password, database: r.creds.dbName, poolSize: 10 }
      : failed('Postgres', r.error);
  }
  if (types.includes('mongo')) {
    const r = await ensureMongoForProject(projectId, projectName, environment);
    result.mongo = r.status === 'ready' && r.creds
      ? { uri: r.creds.uri, database: r.creds.database, user: r.creds.username, poolSize: 5 }
      : failed('MongoDB', r.error);
  }
  if (types.includes('redis')) {
    const r = await ensureRedisForProject(projectId, projectName, environment);
    if (r.status === 'ready' && r.creds) {
      const redis: Record<string, unknown> = {
        host: r.creds.host,
        port: r.creds.port,
        username: r.creds.username,
        password: r.creds.password,
        keyPrefix: r.creds.keyPrefix,
        db: 0,
      };
      // Sentinel fields only when HA is configured (keep single-host response shape unchanged).
      if (r.creds.sentinels?.length) {
        redis.sentinels = r.creds.sentinels;
        redis.masterName = r.creds.masterName;
        redis.sentinelUsername = r.creds.sentinelUsername;
        redis.sentinelPassword = r.creds.sentinelPassword;
      }
      result.redis = redis;
    } else {
      result.redis = failed('Redis', r.error);
    }
  }
  if (errors.length === types.length) throw new Error(errors[0]);
  return result;
}
