import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { notifyRoles } from './notify';
import { patchSecretData, restartNamedDeployment } from './k8s';

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

async function alterPostgresPassword(newPassword: string): Promise<RotateResult> {
  const host = process.env.POSTGRES_HOST || 'postgresql.databases.svc.cluster.local';
  const port = parseInt(process.env.POSTGRES_PORT || '5432', 10);
  const user = process.env.POSTGRES_USER || 'plat';
  const current = process.env.POSTGRES_PASSWORD || 'plat';
  const database = process.env.POSTGRES_DB || 'plat_platform';
  const client = new Client({ host, port, user, password: current, database, connectionTimeoutMillis: 8000 });
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

/**
 * One-click rotation of platform admin + data-store credentials.
 * Returns plaintext values once. JWT is not rotated (would log everyone out).
 */
export async function rotatePlatformSecrets(opts: {
  actorUserId?: string;
}): Promise<{ results: RotateResult[]; values: Record<string, string> }> {
  const actorUserId = opts.actorUserId || '';
  const results: RotateResult[] = [];
  const values: Record<string, string> = {};

  const postgres = randomSecret();
  const redis = randomSecret();
  const mongo = randomSecret();
  const minio = randomSecret();
  const webhook = randomSecret();
  const admin = randomSecret(12);
  const portainer = randomSecret(12);

  const pgAlter = await alterPostgresPassword(postgres);
  results.push(pgAlter);
  if (pgAlter.ok) process.env.POSTGRES_PASSWORD = postgres;
  values.POSTGRES_PASSWORD = postgres;
  values.REDIS_PASSWORD = redis;
  values.MONGO_PASSWORD = mongo;
  values.MINIO_SECRET_KEY = minio;
  values.PLATFORM_WEBHOOK_SECRET = webhook;
  values.ADMIN_PASSWORD = admin;
  values.PORTAINER_ADMIN_PASSWORD = portainer;

  process.env.REDIS_PASSWORD = redis;
  process.env.MONGO_PASSWORD = mongo;
  process.env.MINIO_SECRET_KEY = minio;
  process.env.PLATFORM_WEBHOOK_SECRET = webhook;
  process.env.ADMIN_PASSWORD = admin;

  const platformEnvPatch: Record<string, string> = {
    REDIS_PASSWORD: redis,
    MONGO_PASSWORD: mongo,
    MINIO_SECRET_KEY: minio,
    PLATFORM_WEBHOOK_SECRET: webhook,
    ADMIN_PASSWORD: admin,
  };
  if (pgAlter.ok) platformEnvPatch.POSTGRES_PASSWORD = postgres;
  results.push(await tryPatchSecret('platform', 'platform-env', platformEnvPatch));
  results.push(await tryPatchSecret('databases', 'postgresql', {
    'postgres-password': postgres,
    password: postgres,
  }));
  results.push(await tryPatchSecret('databases', 'redis', { 'redis-password': redis }));
  results.push(await tryPatchSecret('databases', 'mongodb', {
    'mongodb-passwords': mongo,
    'mongodb-root-password': mongo,
  }));
  results.push(await tryPatchSecret('storage', 'minio', { 'root-password': minio }));
  results.push(await tryPatchSecret('portainer', 'portainer-admin-password', { password: portainer }));

  const argocd = randomSecret(12);
  values.ARGOCD_ADMIN_PASSWORD = argocd;
  results.push(await tryPatchSecret('argocd', 'argocd-initial-admin-secret', { password: argocd }));
  try {
    const hash = await bcrypt.hash(argocd, 10);
    results.push(await tryPatchSecret('argocd', 'argocd-secret', {
      'admin.password': hash,
      'admin.passwordMtime': new Date().toISOString(),
    }));
  } catch (err: any) {
    results.push({ key: 'argocd/argocd-secret', ok: false, detail: err?.message || 'argocd password hash failed' });
  }

  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find({ where: { role: UserRole.ADMIN } });
    const hash = await bcrypt.hash(admin, 10);
    for (const u of users) {
      u.passwordHash = hash;
      await ds.getRepository(User).save(u);
    }
    results.push({ key: 'ADMIN_PASSWORD', ok: true, detail: `updated ${users.length} admin user(s)` });
  } catch (err: any) {
    results.push({ key: 'ADMIN_PASSWORD', ok: false, detail: err?.message || 'admin password update failed' });
  }

  const restartTargets: Array<readonly [string, string]> = [
    ['platform', 'platform-api'],
    ['storage', 'minio'],
  ];
  if (pgAlter.ok) restartTargets.push(['databases', 'postgresql']);
  for (const [ns, name] of restartTargets) {
    try {
      await restartNamedDeployment(ns, name);
      results.push({ key: `restart:${ns}/${name}`, ok: true, detail: 'rollout restarted' });
    } catch (err: any) {
      results.push({ key: `restart:${ns}/${name}`, ok: false, detail: err?.message || 'restart failed' });
    }
  }

  await notifyRoles({
    roles: [UserRole.ADMIN, UserRole.DEVOPS],
    title: 'Platform secrets rotated',
    body: 'Admin, database, and related credentials were rotated. Copy the new values from Settings now — they are shown only once.',
    kind: 'security',
    link: '/settings',
    metadata: { actorUserId },
  });

  return { results, values };
}
