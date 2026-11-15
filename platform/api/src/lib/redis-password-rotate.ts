import Redis, { RedisOptions } from 'ioredis';
import {
  buildSentinelAclSetUserArgs, deriveSentinelPassword, redisDataNodes,
  redisSentinelConfig, redisSentinelNodes, RedisLike, SentinelHost,
} from './redis-endpoint';
import { API_REDIS_USER, buildApiAclSetUserArgs, deriveApiRedisPassword } from './redis';

type HaMembers = {
  topology: { sentinels: SentinelHost[]; name: string };
  dataClients: Redis[];
  sentinelClients: Redis[];
};

/**
 * Connect to every Redis data node and Sentinel (preflight: all must authenticate before
 * `fn` changes anything). Each member is tried with `passwords` (data) or
 * `sentinelPasswords` (Sentinel) in order, so an interrupted run can resume from any mix.
 */
async function withHaMembers(
  passwords: string[],
  sentinelPasswords: string[],
  failure: string,
  fn: (members: HaMembers) => Promise<void>,
): Promise<void> {
  const topology = redisSentinelConfig();
  if (!topology) throw new Error('Redis Sentinel is not configured');
  const clients = new Set<Redis>();

  async function connect(node: SentinelHost, sentinel = false): Promise<Redis> {
    for (const password of new Set(sentinel ? sentinelPasswords : passwords)) {
      const client = new Redis({
        ...node, password: password || undefined, lazyConnect: true,
        connectTimeout: 5000, commandTimeout: 5000, maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      client.on('error', () => {});
      try {
        await client.connect();
        await client.ping();
        clients.add(client);
        return client;
      } catch {
        client.disconnect();
      }
    }
    throw new Error(`Redis rotation could not authenticate to ${node.host}:${node.port}`);
  }

  // Reuse topology discovery, but probe each seed with every candidate credential.
  const deps = {
    connect: (opts: RedisOptions): RedisLike => {
      let client: Redis;
      return {
        async connect() { client = await connect({ host: opts.host!, port: opts.port! }, true); },
        async call(command, ...args) { return client.call(command, ...args); },
        disconnect() { client?.disconnect(); },
      };
    },
  };
  try {
    const discovered = await redisDataNodes(passwords[0] || '', deps);
    const sentinels = await redisSentinelNodes(passwords[0] || '', deps);
    const nodes = new Map<string, SentinelHost>();
    for (const node of discovered) nodes.set(`${node.host}:${node.port}`, node);
    // Bitnami colocates Redis and Sentinel. Include even disconnected replicas,
    // which discovery deliberately omits for normal client traffic.
    for (const seed of topology.sentinels) {
      if (/^redis-node-\d+\.redis-headless\b/.test(seed.host)) {
        nodes.set(`${seed.host}:6379`, { host: seed.host, port: 6379 });
      }
    }
    const dataClients: Redis[] = [];
    const sentinelClients: Redis[] = [];
    // Preflight every member before changing any password.
    for (const node of nodes.values()) dataClients.push(await connect(node));
    for (const node of sentinels) sentinelClients.push(await connect(node, true));
    await fn({ topology, dataClients, sentinelClients });
  } catch {
    // Redis errors may echo command arguments. Never put credentials in operation logs.
    throw new Error(failure);
  } finally {
    for (const client of clients) client.disconnect();
  }
}

async function rewriteDataConfig(client: Redis): Promise<void> {
  try {
    await client.config('REWRITE');
  } catch (err: any) {
    // Bitnami regenerates config from the Secret; some mounts are read-only.
    if (!/read.only|permission denied|without a config file/i.test(err?.message || '')) throw err;
  }
}

/** ACL SETUSER args that replace (not add to) the user's passwords; other rules unchanged. */
function withResetPass(args: string[]): string[] {
  return [args[0], args[1], 'resetpass', ...args.slice(2)];
}

/**
 * Rotate each HA member directly; never infer cluster convergence from the master alone.
 *
 * Both passwords stay valid when this returns: the Redis and Sentinel liveness probes read
 * the password from the mounted databases/redis Secret, which kubelet refreshes only after
 * a delay. Call dropPreviousSentinelPassword(next) once the new Secret has reached the pods.
 */
export async function rotateSentinelPassword(previous: string, next: string): Promise<void> {
  const sentinelPrevious = process.env.REDIS_SENTINEL_PASSWORD || previous;
  const sentinelNext = process.env.REDIS_SENTINEL_PASSWORD || next;
  await withHaMembers(
    [next, previous],
    [sentinelNext, sentinelPrevious],
    'Redis Sentinel rotation incomplete; retain pending credentials and retry the rotation',
    async ({ topology, dataClients, sentinelClients }) => {
      for (const client of dataClients) {
        if (!process.env.REDIS_API_USERNAME) {
          await client.call('ACL', ...buildApiAclSetUserArgs(API_REDIS_USER, deriveApiRedisPassword(previous)));
          await client.call('ACL', ...buildApiAclSetUserArgs(API_REDIS_USER, deriveApiRedisPassword(next)));
        }
        // Keep replication and Sentinel monitoring authenticated throughout the change.
        await client.call('ACL', 'SETUSER', 'default', `>${previous}`, `>${next}`);
      }
      for (const client of sentinelClients) {
        await client.call('ACL', ...buildSentinelAclSetUserArgs(deriveSentinelPassword(previous)));
        await client.call('ACL', ...buildSentinelAclSetUserArgs(deriveSentinelPassword(next)));
        await client.call('ACL', 'SETUSER', 'default', `>${sentinelPrevious}`, `>${sentinelNext}`);
      }
      for (const client of dataClients) await client.config('SET', 'masterauth', next);
      for (const client of dataClients) {
        await client.config('SET', 'requirepass', next);
        await client.auth(next);
        // requirepass replaces the default user's passwords; keep the old one for the probes.
        await client.call('ACL', 'SETUSER', 'default', `>${previous}`);
      }
      for (const client of sentinelClients) {
        await client.call('SENTINEL', 'SET', topology.name, 'auth-pass', next);
        // Sentinel does not expose CONFIG SET requirepass. Its default ACL controls
        // incoming auth; sentinel-pass controls authentication to its peers.
        await client.call('SENTINEL', 'CONFIG', 'SET', 'sentinel-pass', sentinelNext);
      }
      for (const client of sentinelClients) {
        await client.auth(sentinelNext);
        await client.call('SENTINEL', 'FLUSHCONFIG');
      }
      for (const client of dataClients) await rewriteDataConfig(client);
    },
  );
}

/**
 * Second phase of a rotation: make `next` the only password of the default user and
 * plat-api on every member. plat-sentinel keeps exactly `next` and `previous` (when given),
 * so apps that read discovery credentials before this rotation keep discovering until the
 * next rotation's drop. Idempotent; run it only after the databases/redis Secret holding
 * `next` has reached the pods (their probes read it from the mount).
 */
export async function dropPreviousSentinelPassword(next: string, previous?: string): Promise<void> {
  const sentinelNext = process.env.REDIS_SENTINEL_PASSWORD || next;
  await withHaMembers(
    [next],
    [sentinelNext],
    'Could not remove the previous Redis password from every member; it stays valid until the next retry',
    async ({ dataClients, sentinelClients }) => {
      for (const client of dataClients) {
        if (!process.env.REDIS_API_USERNAME) {
          await client.call('ACL', ...withResetPass(buildApiAclSetUserArgs(API_REDIS_USER, deriveApiRedisPassword(next))));
        }
        await client.call('ACL', 'SETUSER', 'default', 'resetpass', `>${next}`);
      }
      for (const client of sentinelClients) {
        const args = withResetPass(buildSentinelAclSetUserArgs(deriveSentinelPassword(next)));
        if (previous && previous !== next) args.push(`>${deriveSentinelPassword(previous)}`);
        await client.call('ACL', ...args);
        await client.call('ACL', 'SETUSER', 'default', 'resetpass', `>${sentinelNext}`);
        await client.call('SENTINEL', 'FLUSHCONFIG');
      }
      for (const client of dataClients) await rewriteDataConfig(client);
    },
  );
}
