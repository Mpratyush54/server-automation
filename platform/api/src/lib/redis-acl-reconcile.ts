/**
 * Keep project Redis ACL users alive across Redis restarts.
 *
 * Project users are created with `ACL SETUSER` (lib/project-db-ensure). The bundled Redis
 * runs without an aclfile, so `ACL SAVE` fails and every Redis restart (pod reschedule,
 * chart upgrade, node reboot) forgets them: apps lost Redis until someone called
 * /sdk/db-credentials again. This leader job compares `ACL USERS` with the Redis credentials
 * stored in project secrets every 15 s and re-creates missing users with their stored
 * passwords (same key/channel prefix restrictions), so apps recover within seconds of Redis.
 *
 * In Sentinel (HA) mode ACLs must be applied on every data node (they are not replicated),
 * and the plat-sentinel discovery user is kept on every Sentinel.
 */
import { getDb } from '../config/database';
import { Secret } from '../entities/Secret';
import {
  API_REDIS_USER,
  buildApiAclSetUserArgs,
  deriveApiRedisPassword,
} from './redis';
import {
  ensureSentinelUser,
  forEachRedisDataNode,
  redisSentinelConfig,
  type RedisLike,
} from './redis-endpoint';
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
  const { redisEndpointOptions } = await import('./redis-endpoint');
  const admin = new Redis({
    ...redisEndpointOptions({ defaultHost: 'localhost' }),
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
  // Grouped per call (a local object, not process state).
  const byEnv: Record<string, Record<string, string>> = {};
  for (const r of rows) {
    const id = `${r.projectId}\u0000${r.environmentId ?? ''}`;
    try {
      (byEnv[id] ??= {})[r.key] = decryptStoredSecret(r.encryptedValue);
    } catch {
      continue; // undecryptable: leave the user to the next /sdk/db-credentials call
    }
  }
  const out: StoredRedisUser[] = [];
  for (const [id, v] of Object.entries(byEnv)) {
    const [projectId, environment] = id.split('\u0000');
    if (v.REDIS_USERNAME?.startsWith('plat_') && v.REDIS_PASSWORD && v.REDIS_KEY_PREFIX) {
      out.push({ projectId, environment, username: v.REDIS_USERNAME, password: v.REDIS_PASSWORD, keyPrefix: v.REDIS_KEY_PREFIX });
    }
  }
  return out;
}

async function reconcileOnAdmin(
  admin: RedisAdmin | RedisLike,
  users: StoredRedisUser[],
  log: (msg: string) => void,
  opts: { ensureApiUser?: boolean } = {},
): Promise<string[]> {
  const present = new Set((await admin.call('ACL', 'USERS')) as string[]);
  const platformPassword = process.env.REDIS_PASSWORD || '';
  const restored: string[] = [];

  for (const u of users) {
    if (present.has(u.username)) continue;
    // Legacy installs copied the platform password into project secrets: never grant it.
    if (platformPassword && u.password === platformPassword) continue;
    try {
      await admin.call('ACL', ...buildRedisAclSetUserArgs(u.username, u.password, u.keyPrefix));
      restored.push(u.username);
    } catch (err: any) {
      log(`[redis-acl] could not restore ${u.username}: ${err?.message || err}`);
    }
  }

  // Ensure the API ACL user exists on this node (unless an external user is configured).
  if (opts.ensureApiUser && !process.env.REDIS_API_USERNAME && platformPassword) {
    const apiUser = API_REDIS_USER;
    if (!present.has(apiUser)) {
      try {
        await admin.call('ACL', ...buildApiAclSetUserArgs(apiUser, deriveApiRedisPassword(platformPassword)));
        restored.push(apiUser);
      } catch (err: any) {
        log(`[redis-acl] could not restore ${apiUser}: ${err?.message || err}`);
      }
    }
  }

  if (restored.length > 0) {
    await Promise.resolve(admin.call('ACL', 'SAVE')).catch(() => undefined); // only with an aclfile
  }
  return restored;
}

export async function reconcileProjectRedisUsers(deps: {
  admin?: () => Promise<RedisAdmin>;
  /** Multi-node injection: when set, reconcile runs on each provided admin instead of discovering nodes. */
  nodes?: () => Promise<Array<{ host: string; port: number; role: 'master' | 'replica'; admin: RedisAdmin }>>;
  users?: () => Promise<StoredRedisUser[]>;
  log?: (msg: string) => void;
} = {}): Promise<{ checked: number; restored: string[]; nodes: number }> {
  const users = await (deps.users ?? storedRedisUsers)();
  // Existing single-admin injection path (unit tests).
  if (deps.admin && !deps.nodes) {
    if (users.length === 0) return { checked: 0, restored: [], nodes: 0 };
    const admin = await deps.admin();
    const log = deps.log ?? console.warn;
    try {
      const restored = await reconcileOnAdmin(admin, users, log, { ensureApiUser: false });
      if (restored.length > 0) {
        (deps.log ?? console.log)(`[redis-acl] re-created ${restored.length} project Redis user(s) missing after a Redis restart`);
      }
      return { checked: users.length, restored, nodes: 1 };
    } finally {
      admin.disconnect();
    }
  }

  if (users.length === 0 && !deps.nodes && !process.env.REDIS_HOST && !process.env.REDIS_SENTINEL_HOSTS) {
    return { checked: 0, restored: [], nodes: 0 };
  }

  const log = deps.log ?? console.warn;
  const restoredSet = new Set<string>();
  let nodeCount = 0;

  if (deps.nodes) {
    const nodes = await deps.nodes();
    nodeCount = nodes.length;
    for (const node of nodes) {
      try {
        const restored = await reconcileOnAdmin(node.admin, users, log, { ensureApiUser: true });
        restored.forEach((u) => restoredSet.add(u));
      } finally {
        node.admin.disconnect();
      }
    }
  } else {
    const adminPassword = process.env.REDIS_PASSWORD || '';
    const result = await forEachRedisDataNode(adminPassword, async (client) => {
      const restored = await reconcileOnAdmin(client, users, log, { ensureApiUser: true });
      restored.forEach((u) => restoredSet.add(u));
    });
    nodeCount = result.ok.length + result.failed.length;
    for (const f of result.failed) {
      log(`[redis-acl] node ${f.node}: ${f.error}`);
    }
  }

  if (redisSentinelConfig()) {
    const adminPassword = process.env.REDIS_PASSWORD || '';
    await ensureSentinelUser(adminPassword).catch((err) => {
      log(`[redis-acl] sentinel user ensure skipped: ${err?.message || err}`);
    });
  }

  const restored = [...restoredSet];
  if (restored.length > 0) {
    (deps.log ?? console.log)(`[redis-acl] re-created ${restored.length} Redis user(s) missing after a Redis restart`);
  }
  return { checked: users.length, restored, nodes: nodeCount };
}

export function startRedisAclReconcile(): void {
  if (!process.env.REDIS_HOST && !process.env.REDIS_SENTINEL_HOSTS) return; // no Redis configured (dev/tests)
  registerLeaderJob({
    name: REDIS_ACL_RECONCILE_JOB,
    intervalMs: 15_000,
    initialDelayMs: 5_000,
    run: async () => {
      await reconcileProjectRedisUsers().catch((err) => console.warn(`[redis-acl] reconcile skipped: ${err?.message || err}`));
    },
  });
}
