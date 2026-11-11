/**
 * Keep project Redis ACL users alive across Redis restarts.
 *
 * Project users are created with `ACL SETUSER` (lib/project-db-ensure). The bundled Redis
 * runs without an aclfile, so `ACL SAVE` fails and every Redis restart (pod reschedule,
 * chart upgrade, node reboot) forgets them: apps lost Redis until someone called
 * /sdk/db-credentials again. This leader job compares `ACL USERS` with the Redis credentials
 * stored in project secrets every 15 s and re-creates missing users with their stored
 * passwords (same key/channel prefix restrictions), so apps recover within seconds of Redis.
 */
import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import { buildRedisAclSetUserArgs, decryptStoredSecret } from './project-db-ensure';
import { registerLeaderJob } from './scheduler';

export const REDIS_ACL_RECONCILE_JOB = 'redis-acl-reconcile';

/** The subset of an ioredis client this job needs. */
export interface RedisAdmin {
  call(command: string, ...args: string[]): Promise<unknown>;
  disconnect(): void;
}

export interface StoredRedisUser {
  projectId: string;
  environment: string;
  username: string;
  password: string;
  keyPrefix: string;
}

async function defaultAdmin(): Promise<RedisAdmin> {
  const { default: Redis } = await import('ioredis');
  const admin = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  admin.on('error', () => {});
  await admin.connect();
  return admin as unknown as RedisAdmin;
}

/** Project Redis users recorded in secrets (REDIS_USERNAME / _PASSWORD / _KEY_PREFIX). */
export async function storedRedisUsers(): Promise<StoredRedisUser[]> {
  const ds = await getDb();
  const rows = await ds.getRepository(Secret).createQueryBuilder('s')
    .where('s.isActive = true')
    .andWhere('s.key IN (:...keys)', { keys: ['REDIS_USERNAME', 'REDIS_PASSWORD', 'REDIS_KEY_PREFIX'] })
    .getMany();
  const byEnv = new Map<string, Record<string, string>>();
  for (const r of rows) {
    const id = `${r.projectId}\u0000${r.environmentId ?? ''}`;
    const values = byEnv.get(id) ?? {};
    try {
      values[r.key] = decryptStoredSecret(r.encryptedValue);
    } catch {
      continue; // undecryptable: leave the user to the next /sdk/db-credentials call
    }
    byEnv.set(id, values);
  }
  const out: StoredRedisUser[] = [];
  for (const [id, v] of byEnv) {
    const [projectId, environment] = id.split('\u0000');
    if (v.REDIS_USERNAME?.startsWith('plat_') && v.REDIS_PASSWORD && v.REDIS_KEY_PREFIX) {
      out.push({ projectId, environment, username: v.REDIS_USERNAME, password: v.REDIS_PASSWORD, keyPrefix: v.REDIS_KEY_PREFIX });
    }
  }
  return out;
}

export async function reconcileProjectRedisUsers(deps: {
  admin?: () => Promise<RedisAdmin>;
  users?: () => Promise<StoredRedisUser[]>;
  log?: (msg: string) => void;
} = {}): Promise<{ checked: number; restored: string[] }> {
  const users = await (deps.users ?? storedRedisUsers)();
  if (users.length === 0) return { checked: 0, restored: [] };
  const admin = await (deps.admin ?? defaultAdmin)();
  const restored: string[] = [];
  try {
    const present = new Set((await admin.call('ACL', 'USERS')) as string[]);
    const platformPassword = process.env.REDIS_PASSWORD || '';
    for (const u of users) {
      if (present.has(u.username)) continue;
      // Legacy installs copied the platform password into project secrets: never grant it.
      if (platformPassword && u.password === platformPassword) continue;
      try {
        await admin.call('ACL', ...buildRedisAclSetUserArgs(u.username, u.password, u.keyPrefix));
        restored.push(u.username);
      } catch (err: any) {
        (deps.log ?? console.warn)(`[redis-acl] could not restore ${u.username}: ${err?.message || err}`);
      }
    }
    if (restored.length > 0) {
      await Promise.resolve(admin.call('ACL', 'SAVE')).catch(() => undefined); // only with an aclfile
      (deps.log ?? console.log)(`[redis-acl] re-created ${restored.length} project Redis user(s) missing after a Redis restart`);
    }
  } finally {
    admin.disconnect();
  }
  return { checked: users.length, restored };
}

export function startRedisAclReconcile(): void {
  if (!process.env.REDIS_HOST) return; // no Redis configured (dev/tests)
  registerLeaderJob({
    name: REDIS_ACL_RECONCILE_JOB,
    intervalMs: 15_000,
    initialDelayMs: 5_000,
    run: async () => {
      await reconcileProjectRedisUsers().catch((err) => console.warn(`[redis-acl] reconcile skipped: ${err?.message || err}`));
    },
  });
}
