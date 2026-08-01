import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import { encryptValue, decryptValue } from './secrets-encryption';
import {
  provisionPostgresDb,
  sanitizeDbName,
  generateSecurePassword,
  DbProvisionResult,
} from './database-service';
import { Pool } from 'pg';

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

    if (existing.POSTGRES_DB && existing.POSTGRES_USER && existing.POSTGRES_PASSWORD) {
      // Verify DB still exists / is reachable; recreate role password binding if needed
      const admin = new Pool({
        host,
        port,
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || 'postgres',
        database: 'postgres',
        max: 2,
      });
      const client = await admin.connect();
      try {
        const dbName = existing.POSTGRES_DB;
        const username = existing.POSTGRES_USER;
        const password = existing.POSTGRES_PASSWORD;
        const dbExists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
        if (dbExists.rows.length === 0) {
          await client.query(`CREATE DATABASE "${dbName}" OWNER "${username}"`).catch(async () => {
            // owner may be missing — recreate role
            await client.query(`DO $$ BEGIN
              IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${username}') THEN
                CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password}';
              ELSE
                ALTER ROLE "${username}" WITH LOGIN PASSWORD '${password}';
              END IF;
            END $$;`);
            await client.query(`CREATE DATABASE "${dbName}" OWNER "${username}"`);
          });
        } else {
          // Keep password in sync so stored secret always works
          await client.query(`DO $$ BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${username}') THEN
              ALTER ROLE "${username}" WITH LOGIN PASSWORD '${password}';
            ELSE
              CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password}';
            END IF;
          END $$;`);
          await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`).catch(() => {});
        }
      } finally {
        client.release();
        await admin.end().catch(() => {});
      }

      return {
        status: 'ready',
        creds: {
          dbName: existing.POSTGRES_DB,
          username: existing.POSTGRES_USER,
          password: existing.POSTGRES_PASSWORD,
          host: existing.POSTGRES_HOST || host,
          port: parseInt(existing.POSTGRES_PORT || String(port), 10),
        },
      };
    }

    // Fresh provision — if role already exists without our secret, rotate password
    const safeProjectName = sanitizeDbName(projectName);
    const safeEnv = sanitizeDbName(environment);
    const dbName = `plat_${safeProjectName}_${safeEnv}`;
    const username = `plat_${safeProjectName}_${safeEnv}_user`;
    const password = generateSecurePassword(32);

    const admin = new Pool({
      host,
      port,
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: 'postgres',
      max: 2,
    });
    const client = await admin.connect();
    try {
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${username}') THEN
          CREATE ROLE "${username}" WITH LOGIN PASSWORD '${password}';
        ELSE
          ALTER ROLE "${username}" WITH LOGIN PASSWORD '${password}';
        END IF;
      END $$;`);
      const dbExists = await client.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [dbName]);
      if (dbExists.rows.length === 0) {
        await client.query(`CREATE DATABASE "${dbName}" OWNER "${username}"`);
      }
      await client.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${username}"`);
    } finally {
      client.release();
      await admin.end().catch(() => {});
    }

    const creds: DbProvisionResult = { dbName, username, password, host, port };
    await upsertSecret(projectId, environment, 'POSTGRES_HOST', host);
    await upsertSecret(projectId, environment, 'POSTGRES_PORT', String(port));
    await upsertSecret(projectId, environment, 'POSTGRES_USER', username);
    await upsertSecret(projectId, environment, 'POSTGRES_PASSWORD', password);
    await upsertSecret(projectId, environment, 'POSTGRES_DB', dbName);

    return { status: 'ready', creds };
  } catch (e: any) {
    // Fallback to original provision helper if ensure path fails mid-way
    try {
      const creds = await provisionPostgresDb(projectName, environment);
      await upsertSecret(projectId, environment, 'POSTGRES_HOST', creds.host);
      await upsertSecret(projectId, environment, 'POSTGRES_PORT', String(creds.port));
      await upsertSecret(projectId, environment, 'POSTGRES_USER', creds.username);
      await upsertSecret(projectId, environment, 'POSTGRES_PASSWORD', creds.password);
      await upsertSecret(projectId, environment, 'POSTGRES_DB', creds.dbName);
      return { status: 'ready', creds };
    } catch (e2: any) {
      return { status: 'error', error: e2.message || e.message };
    }
  }
}

export async function ensureMongoForProject(
  projectId: string,
  projectName: string,
  environment: string,
): Promise<{ status: 'ready' | 'error'; uri?: string; error?: string }> {
  try {
    const existing = await readSecrets(projectId, environment);
    if (existing.MONGO_URI) {
      return { status: 'ready', uri: existing.MONGO_URI };
    }

    const base =
      process.env.MONGODB_URI ||
      process.env.MONGO_URI ||
      'mongodb://localhost:27017/plat_platform';
    const safe = sanitizeDbName(`${projectName}_${environment}`);
    const dbName = `plat_${safe}`;
    let uri = `mongodb://localhost:27017/${dbName}`;
    try {
      const u = new URL(base);
      u.pathname = `/${dbName}`;
      uri = u.toString();
    } catch {
      const uriBase = base.split('/').slice(0, 3).join('/') || 'mongodb://localhost:27017';
      uri = `${uriBase}/${dbName}`;
    }

    // Touch the DB so it exists (best-effort) via mongoose connection
    try {
      const mongoose = await import('mongoose');
      const conn = await mongoose.createConnection(uri).asPromise();
      await conn.collection('_platform_init').insertOne({ ok: true, at: new Date() });
      await conn.close();
    } catch (touchErr: any) {
      console.warn('[project-db-ensure] mongo touch:', touchErr.message);
    }

    await upsertSecret(projectId, environment, 'MONGO_URI', uri);
    return { status: 'ready', uri };
  } catch (e: any) {
    return { status: 'error', error: e.message };
  }
}

export async function ensureRedisForProject(
  projectId: string,
  projectName: string,
  environment: string,
): Promise<{ status: 'ready' | 'error'; error?: string }> {
  try {
    const existing = await readSecrets(projectId, environment);
    const host = existing.REDIS_HOST || process.env.REDIS_HOST || 'localhost';
    const port = existing.REDIS_PORT || process.env.REDIS_PORT || '6379';
    const password = existing.REDIS_PASSWORD || process.env.REDIS_PASSWORD || '';
    const prefix =
      existing.REDIS_KEY_PREFIX ||
      `plat:${sanitizeDbName(projectName)}:${sanitizeDbName(environment)}:`;

    await upsertSecret(projectId, environment, 'REDIS_HOST', host);
    await upsertSecret(projectId, environment, 'REDIS_PORT', String(port));
    if (password) await upsertSecret(projectId, environment, 'REDIS_PASSWORD', password);
    await upsertSecret(projectId, environment, 'REDIS_KEY_PREFIX', prefix);

    return { status: 'ready' };
  } catch (e: any) {
    return { status: 'error', error: e.message };
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
export async function resolveProjectDbCredentials(
  projectId: string,
  projectName: string,
  environment: string,
  dbTypes: string[],
): Promise<Record<string, any>> {
  const types = dbTypes.length ? dbTypes : ['postgres', 'mongo', 'redis'];
  await ensureProjectDatabases(projectId, projectName, environment, types);
  const secrets = await readSecrets(projectId, environment);
  const result: Record<string, any> = {};

  if (types.includes('postgres')) {
    result.postgres = {
      host: secrets.POSTGRES_HOST || process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(secrets.POSTGRES_PORT || process.env.POSTGRES_PORT || '5432', 10),
      user: secrets.POSTGRES_USER || process.env.POSTGRES_USER || 'plat',
      password: secrets.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'plat',
      database: secrets.POSTGRES_DB || process.env.POSTGRES_DB || 'plat_platform',
      poolSize: 10,
    };
  }
  if (types.includes('mongo')) {
    result.mongo = {
      uri:
        secrets.MONGO_URI ||
        process.env.MONGODB_URI ||
        process.env.MONGO_URI ||
        'mongodb://localhost:27017/plat_platform',
      poolSize: 5,
    };
  }
  if (types.includes('redis')) {
    result.redis = {
      host: secrets.REDIS_HOST || process.env.REDIS_HOST || 'localhost',
      port: parseInt(secrets.REDIS_PORT || process.env.REDIS_PORT || '6379', 10),
      password: secrets.REDIS_PASSWORD || process.env.REDIS_PASSWORD || '',
      keyPrefix: secrets.REDIS_KEY_PREFIX || '',
    };
  }
  return result;
}
