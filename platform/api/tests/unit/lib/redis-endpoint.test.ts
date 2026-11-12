/**
 * Redis Sentinel / single-host endpoint helpers (no real Redis).
 */
import {
  buildSentinelAclSetUserArgs,
  deriveSentinelPassword,
  forEachRedisDataNode,
  parseSentinelHosts,
  readonlyReconnect,
  redisDataNodes,
  redisEndpointOptions,
  redisSentinelConfig,
  redisSentinelNodes,
  SENTINEL_ACL_USER,
  type RedisLike,
} from '../../../src/lib/redis-endpoint';

function fakeRedis(replies: Record<string, unknown> = {}): RedisLike & { calls: any[][]; opts: any } {
  const calls: any[][] = [];
  const client: RedisLike & { calls: any[][]; opts: any } = {
    opts: {},
    calls,
    on() { return this; },
    async connect() { return undefined; },
    disconnect() {},
    async call(...args: any[]) {
      calls.push(args);
      const key = args.map(String).join(' ');
      if (key in replies) return replies[key];
      // Prefix match for SENTINEL commands
      for (const [k, v] of Object.entries(replies)) {
        if (key.startsWith(k)) return v;
      }
      return 'OK';
    },
  };
  return client;
}

afterEach(() => {
  delete process.env.REDIS_SENTINEL_HOSTS;
  delete process.env.REDIS_SENTINEL_MASTER;
  delete process.env.REDIS_SENTINEL_PASSWORD;
  delete process.env.REDIS_SENTINEL_USERNAME;
  delete process.env.REDIS_HOST;
  delete process.env.REDIS_PORT;
  delete process.env.REDIS_PASSWORD;
});

describe('parseSentinelHosts', () => {
  it('parses host:port lists, defaults port, trims, skips garbage', () => {
    expect(parseSentinelHosts(' a:26379, b ,c:1, ,bad:port, :9, host:99999 ')).toEqual([
      { host: 'a', port: 26379 },
      { host: 'b', port: 26379 },
      { host: 'c', port: 1 },
    ]);
    expect(parseSentinelHosts(undefined)).toEqual([]);
    expect(parseSentinelHosts('')).toEqual([]);
  });
});

describe('redisSentinelConfig / redisEndpointOptions', () => {
  it('returns null / single-host options when REDIS_SENTINEL_HOSTS is unset', () => {
    expect(redisSentinelConfig({} as any)).toBeNull();
    expect(redisEndpointOptions({ defaultHost: 'redis-master.databases.svc.cluster.local' }, {})).toEqual({
      host: 'redis-master.databases.svc.cluster.local',
      port: 6379,
    });
  });

  it('builds sentinel ioredis options with password fallback and READONLY reconnect', () => {
    const env = {
      REDIS_SENTINEL_HOSTS: 's0:26379,s1:26379',
      REDIS_PASSWORD: 'secret',
    } as NodeJS.ProcessEnv;
    expect(redisSentinelConfig(env)).toEqual({
      sentinels: [{ host: 's0', port: 26379 }, { host: 's1', port: 26379 }],
      name: 'mymaster',
    });
    const opts = redisEndpointOptions({}, env);
    expect(opts).toMatchObject({
      sentinels: [{ host: 's0', port: 26379 }, { host: 's1', port: 26379 }],
      name: 'mymaster',
      sentinelPassword: 'secret',
      role: 'master',
    });
    expect(opts.host).toBeUndefined();
    expect(opts.reconnectOnError).toBe(readonlyReconnect);
    expect(readonlyReconnect(new Error('READONLY You can\'t write against a read only replica'))).toBe(2);
    expect(readonlyReconnect(new Error('other'))).toBe(false);
  });
});

describe('redisDataNodes / redisSentinelNodes', () => {
  it('single mode returns the configured host as master', async () => {
    const nodes = await redisDataNodes('pw', { env: { REDIS_HOST: 'redis-master', REDIS_PORT: '6380' } as any });
    expect(nodes).toEqual([{ host: 'redis-master', port: 6380, role: 'master' }]);
    expect(await redisSentinelNodes('pw', { env: { REDIS_HOST: 'redis-master' } as any })).toEqual([]);
  });

  it('sentinel mode discovers master and healthy replicas from the first reachable sentinel', async () => {
    const sentinel = fakeRedis({
      'SENTINEL get-master-addr-by-name mymaster': ['10.0.0.1', '6379'],
      'SENTINEL replicas mymaster': [
        ['ip', '10.0.0.2', 'port', '6379', 'flags', 'slave'],
        ['ip', '10.0.0.3', 'port', '6379', 'flags', 'slave,s_down'],
        ['ip', '10.0.0.4', 'port', '6379', 'flags', 'slave,disconnected'],
      ],
      'SENTINEL sentinels mymaster': [
        ['ip', '10.0.0.10', 'port', '26379'],
      ],
    });
    const env = { REDIS_SENTINEL_HOSTS: 's0.redis:26379', REDIS_SENTINEL_MASTER: 'mymaster' } as NodeJS.ProcessEnv;
    const deps = {
      env,
      connect: (opts: any) => {
        (sentinel as any).opts = opts;
        return sentinel;
      },
    };
    expect(await redisDataNodes('admin', deps)).toEqual([
      { host: '10.0.0.1', port: 6379, role: 'master' },
      { host: '10.0.0.2', port: 6379, role: 'replica' },
    ]);
    expect(await redisSentinelNodes('admin', deps)).toEqual([
      { host: 's0.redis', port: 26379 },
      { host: '10.0.0.10', port: 26379 },
    ]);
  });
});

describe('forEachRedisDataNode', () => {
  it('runs fn on each node and collects failures', async () => {
    const clients: RedisLike[] = [];
    const deps = {
      env: { REDIS_HOST: 'r0', REDIS_PORT: '6379' } as NodeJS.ProcessEnv,
      connect: (opts: any) => {
        const c = fakeRedis();
        (c as any).opts = opts;
        clients.push(c);
        return c;
      },
    };
    const r = await forEachRedisDataNode('admin-pw', async (client, node) => {
      expect(node.role).toBe('master');
      await client.call('PING');
    }, deps);
    expect(r).toEqual({ ok: ['r0:6379'], failed: [] });
    expect((clients[0] as any).opts.password).toBe('admin-pw');
    expect((clients[0] as any).calls[0]).toEqual(['PING']);
  });
});

describe('sentinel ACL helpers', () => {
  it('derives a stable password and builds exact SETUSER args', () => {
    const pass = deriveSentinelPassword('platform-secret');
    expect(pass).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveSentinelPassword('platform-secret')).toBe(pass);
    expect(buildSentinelAclSetUserArgs(pass)).toEqual([
      'SETUSER', SENTINEL_ACL_USER, 'reset', 'on', `>${pass}`,
      '-@all',
      '+ping', '+auth', '+hello',
      '+client|setname', '+client|getname',
      '+sentinel|get-master-addr-by-name',
      '+sentinel|masters', '+sentinel|master',
      '+sentinel|sentinels', '+sentinel|replicas', '+sentinel|slaves',
      '+subscribe', '+psubscribe', '+unsubscribe', '+punsubscribe',
      'allchannels',
    ]);
  });
});
