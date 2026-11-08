import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import { encryptValue, decryptValue } from './secrets-encryption';
import {
  generateSecurePassword,
  DbProvisionResult,
} from './database-service';
import { Pool } from 'pg';
import { Project } from '../entities/Project';
import { createHash } from 'crypto';

const MASTER_KEY = () =>
  process.env.SECRETS_ENCRYPTION_KEY ||
  process.env.JWT_SECRET ||
  'plat-db-creds-fallback';

async function upsertSecret(
  projectId: string,
  environment: string,
  key: string,
  value: string,
): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(Secret);
  const encrypted = encryptValue(String(value), MASTER_KEY());
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
        out[s.key] = decryptValue(s.encryptedValue, MASTER_KEY());
      } catch {}
    }
    return out;
  } catch {
    return {};
  }
}

/** Ensure Postgres role+DB exist; persist credentials for SDK getDbCredentials. Idempotent. */
export async function ensurePostgresForProject(
  projectId: string,
  projectName: string,
  environment: string,
): Promise<{ status: 'ready' | 'error'; creds?: DbProvisionResult; error?: string }> {
  try {
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
      const id = createHash('sha256').update(projectId).digest('hex').slice(0, 20);
      const env = createHash('sha256').update(environment).digest('hex').slice(0, 12);
      identity = { dbName: `plat_${id}_${env}`, username: `plat_${id}_${env}_user` };
      project.databaseResources = { ...(project.databaseResources || {}), [environment]: identity };
      await repo.save(project);
    }
    const { dbName, username } = identity;
    if (username === (process.env.POSTGRES_USER || 'postgres') || dbName === (process.env.POSTGRES_DB || 'plat_platform')) {
      throw new Error('Platform database credentials cannot be used by a project');
    }
    const password = existing.POSTGRES_PASSWORD || generateSecurePassword(32);
    const admin = new Pool({ host, port, user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres', database: 'postgres', max: 2 });
    try {
      const client = await admin.connect();
      try {
        const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
        await client.query(`${role.rows.length ? 'ALTER' : 'CREATE'} ROLE ${client.escapeIdentifier(username)} WITH LOGIN PASSWORD ${client.escapeLiteral(password)}`);
        const db = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        if (!db.rows.length) await client.query(`CREATE DATABASE ${client.escapeIdentifier(dbName)} OWNER ${client.escapeIdentifier(username)}`);
        await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${client.escapeIdentifier(dbName)} TO ${client.escapeIdentifier(username)}`);
      } finally { client.release(); }
    } finally { await admin.end(); }

    const creds: DbProvisionResult = { dbName, username, password, host, port };
    await upsertSecret(projectId, environment, 'POSTGRES_HOST', host);
    await upsertSecret(projectId, environment, 'POSTGRES_PORT', String(port));
    await upsertSecret(projectId, environment, 'POSTGRES_USER', username);
    await upsertSecret(projectId, environment, 'POSTGRES_PASSWORD', password);
    await upsertSecret(projectId, environment, 'POSTGRES_DB', dbName);

    return { status: 'ready', creds };
  } catch (e: any) {
    return { status: 'error', error: e.message || 'Postgres provisioning failed' };
  }
}

export async function ensureMongoForProject(
  projectId: string,
  projectName: string,
  environment: string,
): Promise<{ status: 'ready' | 'error'; uri?: string; error?: string }> {
  return { status: 'error', error: 'Isolated MongoDB users are not configured; project credentials are unavailable' };
}

export async function ensureRedisForProject(
  projectId: string, projectName: string, environment: string,
): Promise<{ status: 'ready' | 'error'; error?: string }> {
  return { status: 'error', error: 'Isolated Redis ACL users are not configured; project credentials are unavailable' };
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
export async function resolveProjectDbCredentials(
  projectId: string,
  projectName: string,
  environment: string,
  dbTypes: string[],
): Promise<Record<string, any>> {
  const types = dbTypes.length ? dbTypes : ['postgres', 'mongo', 'redis'];
  if (types.includes('mongo')) throw new Error('Isolated MongoDB users are not configured; project credentials are unavailable');
  if (types.includes('redis')) throw new Error('Isolated Redis ACL users are not configured; project credentials are unavailable');
  if (types.some(type => type !== 'postgres')) throw new Error('Unsupported database type');
  const result = await ensurePostgresForProject(projectId, projectName, environment);
  if (result.status !== 'ready' || !result.creds) throw new Error(result.error || 'Project database credentials are unavailable');
  const creds = result.creds;
  return { postgres: { host: creds.host, port: creds.port, user: creds.username,
    password: creds.password, database: creds.dbName, poolSize: 10 } };
}
