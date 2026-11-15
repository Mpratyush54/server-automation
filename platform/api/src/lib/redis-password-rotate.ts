import Redis, { RedisOptions } from 'ioredis';
import {
  buildSentinelAclSetUserArgs, deriveSentinelPassword, redisDataNodes,
  redisSentinelConfig, redisSentinelNodes, RedisLike, SentinelHost,
} from './redis-endpoint';
import { API_REDIS_USER, buildApiAclSetUserArgs, deriveApiRedisPassword } from './redis';

/** Rotate each HA member directly; never infer cluster convergence from the master alone. */
export async function rotateSentinelPassword(previous: string, next: string): Promise<void> {
  const topology = redisSentinelConfig();
  if (!topology) throw new Error('Redis Sentinel is not configured');
  const clients = new Set<Redis>();
  const sentinelPrevious = process.env.REDIS_SENTINEL_PASSWORD || previous;
  const sentinelNext = process.env.REDIS_SENTINEL_PASSWORD || next;

  async function connect(node: SentinelHost, sentinel = false): Promise<Redis> {
    const passwords = sentinel ? [sentinelNext, sentinelPrevious] : [next, previous];
    for (const password of new Set(passwords)) {
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

  // Reuse topology discovery, but probe each seed with both credentials on resume.
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
    const discovered = await redisDataNodes(previous, deps);
    const sentinels = await redisSentinelNodes(previous, deps);
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
      await client.call('ACL', 'SETUSER', 'default', `>${previous}`);
    }
    for (const client of sentinelClients) {
      await client.call('SENTINEL', 'SET', topology.name, 'auth-pass', next);
      // Sentinel does not expose CONFIG SET requirepass. Its default ACL controls
      // incoming auth; sentinel-pass controls authentication to its peers.
      await client.call('SENTINEL', 'CONFIG', 'SET', 'sentinel-pass', sentinelNext);
    }
    for (const client of sentinelClients) {
      await client.call('ACL', 'SETUSER', 'default', 'resetpass', `>${sentinelNext}`);
      await client.auth(sentinelNext);
      await client.call('SENTINEL', 'FLUSHCONFIG');
    }
    for (const client of dataClients) {
      await client.call('ACL', 'SETUSER', 'default', 'resetpass', `>${next}`);
      try {
        await client.config('REWRITE');
      } catch (err: any) {
        // Bitnami regenerates config from the Secret; some mounts are read-only.
        if (!/read.only|permission denied|without a config file/i.test(err?.message || '')) throw err;
      }
    }
  } catch {
    // Redis errors may echo command arguments. Never put credentials in operation logs.
    throw new Error('Redis Sentinel rotation incomplete; retain pending credentials and retry the rotation');
  } finally {
    for (const client of clients) client.disconnect();
  }
}
