/**
 * Issue #18: the shared client authenticates as the dedicated ACL user created from the
 * platform Redis secret, and falls back sensibly.
 */
const mockInstances: any[] = [];
let mockConnectFails = false;
let mockAclFails = false;

jest.mock('ioredis', () => {
  class FakeRedis {
    calls: any[][] = [];
    handlers: Record<string, Array<(...a: any[]) => void>> = {};
    constructor(public options: any) {
      mockInstances.push(this);
    }
    on(ev: string, fn: (...a: any[]) => void) {
      (this.handlers[ev] ||= []).push(fn);
      return this;
    }
    async connect() {
      if (mockConnectFails) throw new Error('connect ECONNREFUSED');
    }
    async call(...args: any[]) {
      this.calls.push(args);
      if (mockAclFails) throw new Error('ERR unknown command ACL');
      return 'OK';
    }
    disconnect() {}
    async quit() { return 'OK'; }
    duplicate(opts: any) { return new FakeRedis({ ...this.options, ...opts }); }
  }
  return { __esModule: true, default: FakeRedis };
});

import { API_REDIS_USER, closeRedis, deriveApiRedisPassword, getRedis } from '../../../src/lib/redis';

beforeEach(async () => {
  await closeRedis();
  mockInstances.length = 0;
  mockConnectFails = false;
  mockAclFails = false;
  process.env.REDIS_PASSWORD = 'admin-secret';
  process.env.REDIS_HOST = 'redis.test';
  delete process.env.REDIS_API_USERNAME;
  delete process.env.REDIS_API_PASSWORD;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('creates the plat-api ACL user with the admin password and connects as it', async () => {
  const client: any = await getRedis();
  const [admin] = mockInstances;
  expect(admin.options.password).toBe('admin-secret');
  expect(admin.calls[0].slice(0, 3)).toEqual(['ACL', 'SETUSER', API_REDIS_USER]);
  expect(admin.calls[0]).toContain('~plat:api:*');
  expect(client.options.username).toBe(API_REDIS_USER);
  expect(client.options.password).toBe(deriveApiRedisPassword('admin-secret'));
  expect(client.options.host).toBe('redis.test');
  expect(await getRedis()).toBe(client); // shared
});

it('falls back to the default user when ACLs are not supported', async () => {
  mockAclFails = true;
  const client: any = await getRedis();
  expect(client.options.username).toBeUndefined();
  expect(client.options.password).toBe('admin-secret');
});

it('rejects while Redis is unreachable and retries on the next call', async () => {
  mockConnectFails = true;
  await expect(getRedis()).rejects.toThrow(/ECONNREFUSED/);
  mockConnectFails = false;
  const client: any = await getRedis();
  expect(client.options.username).toBe(API_REDIS_USER);
});

it('uses an externally managed user when REDIS_API_USERNAME/PASSWORD are set', async () => {
  process.env.REDIS_API_USERNAME = 'custom';
  process.env.REDIS_API_PASSWORD = 'custom-pw';
  const client: any = await getRedis();
  expect(mockInstances).toHaveLength(1); // no admin connection
  expect(client.options).toMatchObject({ username: 'custom', password: 'custom-pw' });
});

it('re-creates the ACL user when Redis reports WRONGPASS (restart without ACL file)', async () => {
  const client: any = await getRedis();
  const before = mockInstances.length;
  client.handlers.error.forEach((fn: any) => fn(new Error('WRONGPASS invalid username-password pair')));
  await new Promise((r) => setImmediate(r));
  const repair = mockInstances[before];
  expect(repair.options.password).toBe('admin-secret');
  expect(repair.calls[0].slice(0, 3)).toEqual(['ACL', 'SETUSER', API_REDIS_USER]);
});
