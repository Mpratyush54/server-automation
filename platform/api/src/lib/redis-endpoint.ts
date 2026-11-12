/**
 * Redis endpoint helpers for single-host and Sentinel (HA) deployments.
 *
 * Without REDIS_SENTINEL_HOSTS everything behaves as today (host/port). With Sentinel,
 * clients discover the current master; ACL users are applied on every data node because
 * Redis does not replicate ACLs.
 */
import crypto from 'crypto';
import type { RedisOptions } from 'ioredis';

export type SentinelHost = { host: string; port: number };
export type RedisDataNode = { host: string; port: number; role: 'master' | 'replica' };

export interface RedisLike {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  connect(): Promise<unknown>;
  disconnect(): void;
  on?(event: string, fn: (...args: any[]) => void): unknown;
}

export interface RedisEndpointDeps {
  connect?: (opts: RedisOptions) => RedisLike;
  env?: NodeJS.ProcessEnv;
}

export const SENTINEL_ACL_USER = 'plat-sentinel';

/** Password for the shared Sentinel discovery ACL user (derived; no extra secret). */
export function deriveSentinelPassword(adminPassword: string): string {
  return crypto.createHmac('sha256', adminPassword).update('plat-sentinel-acl-v1').digest('hex');
}

/**
 * ACL SETUSER args for plat-sentinel: topology discovery only (no SET/FAILOVER/RESET, no data).
 */
export function buildSentinelAclSetUserArgs(password: string): string[] {
  return [
    'SETUSER', SENTINEL_ACL_USER, 'reset', 'on', `>${password}`,
    '-@all',
    '+ping', '+auth', '+hello',
    '+client|setname', '+client|getname',
    '+sentinel|get-master-addr-by-name',
    '+sentinel|masters', '+sentinel|master',
    '+sentinel|sentinels', '+sentinel|replicas', '+sentinel|slaves',
    '+subscribe', '+psubscribe', '+unsubscribe', '+punsubscribe',
    'allchannels',
  ];
}

/** Comma list of host:port (default port 26379); trims, skips empties/invalid entries. */
export function parseSentinelHosts(value?: string): SentinelHost[] {
  if (!value || !String(value).trim()) return [];
  const out: SentinelHost[] = [];
  for (const part of String(value).split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    const idx = raw.lastIndexOf(':');
    let host: string;
    let port: number;
    if (idx > 0 && /^\d+$/.test(raw.slice(idx + 1))) {
      host = raw.slice(0, idx).trim();
      port = parseInt(raw.slice(idx + 1), 10);
    } else if (idx === -1 && raw.length > 0) {
      host = raw;
      port = 26379;
    } else {
      continue;
    }
    if (!host || !Number.isFinite(port) || port < 1 || port > 65535) continue;
    // Reject whitespace/garbage hosts
    if (/\s/.test(host)) continue;
    out.push({ host, port });
  }
  return out;
}

export function redisSentinelConfig(env: NodeJS.ProcessEnv = process.env): { sentinels: SentinelHost[]; name: string } | null {
  const sentinels = parseSentinelHosts(env.REDIS_SENTINEL_HOSTS);
  if (sentinels.length === 0) return null;
  return {
    sentinels,
    name: (env.REDIS_SENTINEL_MASTER || 'mymaster').trim() || 'mymaster',
  };
}

/** Reconnect + resend after a demoted master returns READONLY (Sentinel mode only). */
export function readonlyReconnect(err: Error): 2 | false {
  return /READONLY/.test(err?.message || '') ? 2 : false;
}

/**
 * ioredis options for the current Redis topology.
 * Sentinel mode omits host/port; single mode uses REDIS_HOST / defaultHost.
 */
export function redisEndpointOptions(
  opts: { defaultHost?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Partial<RedisOptions> {
  const sentinel = redisSentinelConfig(env);
  if (sentinel) {
    return {
      sentinels: sentinel.sentinels,
      name: sentinel.name,
      sentinelPassword: env.REDIS_SENTINEL_PASSWORD || env.REDIS_PASSWORD || undefined,
      sentinelUsername: env.REDIS_SENTINEL_USERNAME || undefined,
      role: 'master',
      reconnectOnError: readonlyReconnect,
    };
  }
  return {
    host: env.REDIS_HOST || opts.defaultHost,
    port: Number(env.REDIS_PORT) || 6379,
  };
}

function flatPairs(reply: unknown): Record<string, string> {
  const arr = Array.isArray(reply) ? reply : [];
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < arr.length; i += 2) {
    out[String(arr[i])] = String(arr[i + 1]);
  }
  return out;
}

async function defaultConnect(opts: RedisOptions): Promise<RedisLike> {
  const { default: Redis } = await import('ioredis');
  const client = new Redis({ ...opts, lazyConnect: opts.lazyConnect !== false });
  client.on('error', () => {});
  return client as unknown as RedisLike;
}

function connector(deps?: RedisEndpointDeps): (opts: RedisOptions) => Promise<RedisLike> {
  if (deps?.connect) {
    return async (opts) => deps.connect!(opts);
  }
  return defaultConnect;
}

/** Current Redis data nodes (master + healthy replicas), or the single host when not using Sentinel. */
export async function redisDataNodes(
  adminPassword: string,
  deps?: RedisEndpointDeps,
): Promise<RedisDataNode[]> {
  const env = deps?.env ?? process.env;
  const sentinel = redisSentinelConfig(env);
  if (!sentinel) {
    return [{
      host: env.REDIS_HOST || 'localhost',
      port: Number(env.REDIS_PORT) || 6379,
      role: 'master',
    }];
  }

  const connect = connector(deps);
  let lastErr: Error | undefined;
  for (const seed of sentinel.sentinels) {
    const client = await connect({
      host: seed.host,
      port: seed.port,
      password: adminPassword || undefined,
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await client.connect();
      const masterAddr = await client.call('SENTINEL', 'get-master-addr-by-name', sentinel.name) as string[];
      if (!Array.isArray(masterAddr) || masterAddr.length < 2) {
        throw new Error(`SENTINEL get-master-addr-by-name ${sentinel.name} returned no address`);
      }
      const nodes: RedisDataNode[] = [{
        host: String(masterAddr[0]),
        port: parseInt(String(masterAddr[1]), 10),
        role: 'master',
      }];
      const replicas = await client.call('SENTINEL', 'replicas', sentinel.name) as unknown[];
      for (const row of Array.isArray(replicas) ? replicas : []) {
        const info = flatPairs(row);
        const flags = info.flags || '';
        if (/s_down|o_down|disconnected/.test(flags)) continue;
        if (!info.ip || !info.port) continue;
        nodes.push({ host: info.ip, port: parseInt(info.port, 10), role: 'replica' });
      }
      return nodes;
    } catch (err: any) {
      lastErr = err;
    } finally {
      client.disconnect();
    }
  }
  throw lastErr || new Error('No reachable Redis Sentinel');
}

/** Every Sentinel (seeds + discovered peers). Empty in single-host mode. */
export async function redisSentinelNodes(
  adminPassword: string,
  deps?: RedisEndpointDeps,
): Promise<SentinelHost[]> {
  const env = deps?.env ?? process.env;
  const sentinel = redisSentinelConfig(env);
  if (!sentinel) return [];

  // Call-scoped de-duplication (not shared state).
  const seen: Record<string, SentinelHost> = {};
  const add = (h: SentinelHost) => {
    const key = `${h.host}:${h.port}`;
    if (!seen[key]) seen[key] = h;
  };
  for (const s of sentinel.sentinels) add(s);

  const connect = connector(deps);
  for (const seed of sentinel.sentinels) {
    const client = await connect({
      host: seed.host,
      port: seed.port,
      password: adminPassword || undefined,
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await client.connect();
      const peers = await client.call('SENTINEL', 'sentinels', sentinel.name) as unknown[];
      for (const row of Array.isArray(peers) ? peers : []) {
        const info = flatPairs(row);
        if (info.ip && info.port) add({ host: info.ip, port: parseInt(info.port, 10) });
      }
      break; // first reachable seed is enough
    } catch {
      // try next seed
    } finally {
      client.disconnect();
    }
  }
  return Object.values(seen);
}

/**
 * Run `fn` on a short-lived admin client per data node. Always disconnects.
 * Collects per-node errors; never logs passwords.
 */
export async function forEachRedisDataNode(
  adminPassword: string,
  fn: (client: RedisLike, node: RedisDataNode) => Promise<void>,
  deps?: RedisEndpointDeps,
): Promise<{ ok: string[]; failed: { node: string; error: string }[] }> {
  const env = deps?.env ?? process.env;
  const nodes = await redisDataNodes(adminPassword, deps);
  const connect = connector(deps);
  const ok: string[] = [];
  const failed: { node: string; error: string }[] = [];

  for (const node of nodes) {
    const label = `${node.host}:${node.port}`;
    const client = await connect({
      host: node.host,
      port: node.port,
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      username: env.REDIS_USERNAME || undefined,
      password: adminPassword || undefined,
    });
    try {
      await client.connect();
      await fn(client, node);
      ok.push(label);
    } catch (err: any) {
      failed.push({ node: label, error: err?.message || String(err) });
    } finally {
      client.disconnect();
    }
  }
  return { ok, failed };
}

/** Ensure the plat-sentinel discovery user exists on every Sentinel. */
export async function ensureSentinelUser(
  adminPassword: string,
  deps?: RedisEndpointDeps,
): Promise<{ ok: string[]; failed: { node: string; error: string }[] }> {
  const env = deps?.env ?? process.env;
  if (!redisSentinelConfig(env)) return { ok: [], failed: [] };

  const password = deriveSentinelPassword(adminPassword);
  const args = buildSentinelAclSetUserArgs(password);
  const nodes = await redisSentinelNodes(adminPassword, deps);
  const connect = connector(deps);
  const ok: string[] = [];
  const failed: { node: string; error: string }[] = [];

  for (const node of nodes) {
    const label = `${node.host}:${node.port}`;
    const client = await connect({
      host: node.host,
      port: node.port,
      password: adminPassword || undefined,
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await client.connect();
      await client.call('ACL', ...args);
      ok.push(label);
    } catch (err: any) {
      failed.push({ node: label, error: err?.message || String(err) });
    } finally {
      client.disconnect();
    }
  }
  return { ok, failed };
}
