import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import Redis from 'ioredis';
import { getDb, reconnectPostgres } from '../config/database';
import { User, UserRole } from '../entities/User';
import { notifyRoles } from './notify';
import { patchSecretData, restartNamedDeployment } from './k8s';
import {
  clearRotatePending,
  recoverPostgresAuth,
  recoverRedisAuth,
  writeRotatePending,
} from './credential-recover';

function randomSecret(bytes = 18): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export type RotateResult = {
  key: string;
  ok: boolean;
  detail: string;
};

async function tryPatchSecret(namespace: string, name: string, data: Record<string, string>): Promise<RotateResult> {
  try {
    await patchSecretData(namespace, name, data);
    return { key: `${namespace}/${name}`, ok: true, detail: 'secret updated' };
  } catch (err: any) {
    return { key: `${namespace}/${name}`, ok: false, detail: err?.message || 'secret patch failed' };
  }
}

function postgresUser(): string {
  return process.env.POSTGRES_USER || 'postgres';
}

async function alterPostgresPassword(newPassword: string): Promise<RotateResult> {
  const host = process.env.POSTGRES_HOST || 'postgresql.databases.svc.cluster.local';
  const port = parseInt(process.env.POSTGRES_PORT || '5432', 10);
  const user = postgresUser();
  const current = process.env.POSTGRES_PASSWORD || '';
  const database = process.env.POSTGRES_DB || 'platform';
  const client = new Client({
    host,
    port,
    user,
    password: current,
    database,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    const ident = user.replace(/"/g, '');
    const escaped = newPassword.replace(/'/g, "''");
    await client.query(`ALTER USER "${ident}" WITH PASSWORD '${escaped}'`);
    return { key: 'POSTGRES_PASSWORD', ok: true, detail: `ALTER USER ${ident}` };
  } catch (err: any) {
    return { key: 'POSTGRES_PASSWORD', ok: false, detail: err?.message || 'postgres ALTER USER failed' };
  } finally {
    await client.end().catch(() => {});
  }
}

async function alterRedisPassword(newPassword: string): Promise<RotateResult> {
  const host = process.env.REDIS_HOST || 'redis-master.databases.svc.cluster.local';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const current = process.env.REDIS_PASSWORD || '';
  const client = new Redis({
    host,
    port,
    password: current || undefined,
    connectTimeout: 5000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.config('SET', 'requirepass', newPassword);
    await client.auth(newPassword);
    return { key: 'REDIS_PASSWORD', ok: true, detail: 'CONFIG SET requirepass' };
  } catch (err: any) {
    return { key: 'REDIS_PASSWORD', ok: false, detail: err?.message || 'redis CONFIG SET failed' };
  } finally {
    client.disconnect();
  }
}

async function rotateAdminPassword(admin: string): Promise<RotateResult> {
  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find({ where: { role: UserRole.ADMIN } });
    const hash = await bcrypt.hash(admin, 10);
    for (const u of users) {
      u.passwordHash = hash;
      await ds.getRepository(User).save(u);
    }
    return { key: 'ADMIN_PASSWORD', ok: true, detail: `updated ${users.length} admin user(s)` };
  } catch (err: any) {
    return { key: 'ADMIN_PASSWORD', ok: false, detail: err?.message || 'admin password update failed' };
  }
}

async function healPostgres(results: RotateResult[]): Promise<void> {
  try {
    const recovered = await recoverPostgresAuth();
    results.push({
      key: 'POSTGRES_RECOVER',
      ok: recovered.ok,
      detail: recovered.detail,
    });
  } catch (err: any) {
    results.push({
      key: 'POSTGRES_RECOVER',
      ok: false,
      detail: err?.message || 'postgres self-recovery failed',
    });
  }
}

async function healRedis(results: RotateResult[]): Promise<void> {
  try {
    const recovered = await recoverRedisAuth();
    results.push({
      key: 'REDIS_RECOVER',
      ok: recovered.ok,
      detail: recovered.detail,
    });
  } catch (err: any) {
    results.push({
      key: 'REDIS_RECOVER',
      ok: false,
      detail: err?.message || 'redis self-recovery failed',
    });
  }
}

/**
 * Rotate credentials that can be changed live, then patch matching Kubernetes
 * secrets. Mongo/MinIO/Portainer passwords are not written to platform-env
 * unless those servers were updated — otherwise the API crash-loops on restart.
 *
 * Write-ahead: old+new passwords are stored in platform-rotate-pending before
 * ALTER USER / CONFIG SET. If this process dies or TypeORM cannot reconnect,
 * the next API boot tries every stored copy and syncs secrets to whichever
 * password still authenticates — no host SSH required.
 */
export async function rotatePlatformSecrets(opts: {
  actorUserId?: string;
}): Promise<{ results: RotateResult[]; values: Record<string, string> }> {
  const actorUserId = opts.actorUserId || '';
  const results: RotateResult[] = [];
  const values: Record<string, string> = {};

  const admin = randomSecret(12);
  const webhook = randomSecret();
  const postgres = randomSecret();
  const redisPassword = randomSecret();
  const previousPostgres = process.env.POSTGRES_PASSWORD || '';
  const previousRedis = process.env.REDIS_PASSWORD || '';

  const adminResult = await rotateAdminPassword(admin);
  results.push(adminResult);
  if (adminResult.ok) {
    values.ADMIN_PASSWORD = admin;
    process.env.ADMIN_PASSWORD = admin;
  }

  await notifyRoles({
    roles: [UserRole.ADMIN, UserRole.DEVOPS],
    title: 'Platform secrets rotated',
    body: 'Admin and live datastore credentials were rotated. Copy the new values from Settings now — they are shown only once. Also update POSTGRES_PASSWORD / REDIS_PASSWORD in /etc/platform/.env so bootstrap does not re-apply the old passwords.',
    kind: 'security',
    link: '/settings',
    metadata: { actorUserId },
  });

  values.PLATFORM_WEBHOOK_SECRET = webhook;
  process.env.PLATFORM_WEBHOOK_SECRET = webhook;

  try {
    await writeRotatePending({
      POSTGRES_PASSWORD_OLD: previousPostgres,
      POSTGRES_PASSWORD_NEW: postgres,
      REDIS_PASSWORD_OLD: previousRedis,
      REDIS_PASSWORD_NEW: redisPassword,
    });
    results.push({ key: 'platform/platform-rotate-pending', ok: true, detail: 'wrote old+new passwords for self-recovery' });
  } catch (err: any) {
    results.push({
      key: 'platform/platform-rotate-pending',
      ok: false,
      detail: err?.message || 'could not write rotate-pending secret',
    });
  }

  const redisResult = await alterRedisPassword(redisPassword);
  results.push(redisResult);
  if (redisResult.ok) {
    values.REDIS_PASSWORD = redisPassword;
    process.env.REDIS_PASSWORD = redisPassword;
  } else {
    await healRedis(results);
  }

  const pgAlter = await alterPostgresPassword(postgres);
  results.push(pgAlter);
  if (pgAlter.ok) {
    values.POSTGRES_PASSWORD = postgres;
    process.env.POSTGRES_PASSWORD = postgres;
    try {
      await reconnectPostgres(postgres);
    } catch (err: any) {
      results.push({
        key: 'POSTGRES_RECONNECT',
        ok: false,
        detail: err?.message || 'TypeORM reconnect after ALTER failed',
      });
      await healPostgres(results);
    }
  } else {
    await healPostgres(results);
  }

  const platformEnvPatch: Record<string, string> = {
    PLATFORM_WEBHOOK_SECRET: webhook,
  };
  if (adminResult.ok) platformEnvPatch.ADMIN_PASSWORD = admin;
  if (pgAlter.ok) platformEnvPatch.POSTGRES_PASSWORD = postgres;
  if (redisResult.ok) platformEnvPatch.REDIS_PASSWORD = redisPassword;
  results.push(await tryPatchSecret('platform', 'platform-env', platformEnvPatch));

  if (pgAlter.ok) {
    results.push(await tryPatchSecret('databases', 'postgresql', {
      'postgres-password': postgres,
      password: postgres,
    }));
  } else {
    results.push({
      key: 'databases/postgresql',
      ok: false,
      detail: 'skipped: postgres ALTER USER did not succeed',
    });
  }

  if (redisResult.ok) {
    results.push(await tryPatchSecret('databases', 'redis', { 'redis-password': redisPassword }));
  } else {
    results.push({
      key: 'databases/redis',
      ok: false,
      detail: 'skipped: redis CONFIG SET did not succeed',
    });
  }

  const argocd = randomSecret(12);
  try {
    const hash = await bcrypt.hash(argocd, 10);
    const patched = await tryPatchSecret('argocd', 'argocd-secret', {
      'admin.password': hash,
      'admin.passwordMtime': new Date().toISOString(),
    });
    results.push(patched);
    if (patched.ok) {
      values.ARGOCD_ADMIN_PASSWORD = argocd;
      results.push(await tryPatchSecret('argocd', 'argocd-initial-admin-secret', { password: argocd }));
    }
  } catch (err: any) {
    results.push({ key: 'argocd/argocd-secret', ok: false, detail: err?.message || 'argocd password hash failed' });
  }

  if (pgAlter.ok && redisResult.ok) {
    try {
      await clearRotatePending();
      results.push({ key: 'platform/platform-rotate-pending', ok: true, detail: 'cleared after successful rotate' });
    } catch (err: any) {
      results.push({
        key: 'platform/platform-rotate-pending',
        ok: false,
        detail: err?.message || 'could not clear rotate-pending secret',
      });
    }
  }

  try {
    await restartNamedDeployment('platform', 'platform-api');
    results.push({ key: 'restart:platform/platform-api', ok: true, detail: 'rollout restarted' });
  } catch (err: any) {
    results.push({ key: 'restart:platform/platform-api', ok: false, detail: err?.message || 'restart failed' });
  }

  return { results, values };
}
