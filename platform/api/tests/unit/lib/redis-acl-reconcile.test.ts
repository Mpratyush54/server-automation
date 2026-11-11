/**
 * Redis runs without an aclfile, so a Redis restart forgets every project ACL user. The
 * leader job re-creates missing users from the credentials stored in project secrets.
 */
import { reconcileProjectRedisUsers, RedisAdmin, StoredRedisUser } from '../../../src/lib/redis-acl-reconcile';

function fakeAdmin(existing: string[]) {
  const calls: string[][] = [];
  const admin: RedisAdmin = {
    call: async (cmd: string, ...args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'USERS') return ['default', ...existing];
      if (args[0] === 'SAVE') throw new Error('ERR This Redis instance is not configured to use an ACL file');
      return 'OK';
    },
    disconnect: jest.fn(),
  };
  return { admin, calls };
}

const user = (n: string, password = `pw-${n}-0123456789`): StoredRedisUser => ({
  projectId: `p-${n}`, environment: 'development', username: `plat_${n}_dev`, password, keyPrefix: `plat:${n}:dev:`,
});

afterEach(() => { delete process.env.REDIS_PASSWORD; });

it('re-creates only the users missing after a Redis restart, with their stored password and prefix', async () => {
  const { admin, calls } = fakeAdmin(['plat_a_dev']);
  const r = await reconcileProjectRedisUsers({ admin: async () => admin, users: async () => [user('a'), user('b')], log: () => undefined });
  expect(r).toEqual({ checked: 2, restored: ['plat_b_dev'] });
  const setuser = calls.filter((c) => c[1] === 'SETUSER');
  expect(setuser).toHaveLength(1);
  expect(setuser[0]).toEqual(['ACL', 'SETUSER', 'plat_b_dev', 'reset', 'on', '>pw-b-0123456789', '~plat:b:dev:*', '&plat:b:dev:*', '+@all', '-@admin', '-@dangerous']);
  expect(admin.disconnect).toHaveBeenCalled();
});

it('never grants the platform Redis password to a project user (legacy copies)', async () => {
  process.env.REDIS_PASSWORD = 'platform-secret';
  const { admin, calls } = fakeAdmin([]);
  const r = await reconcileProjectRedisUsers({ admin: async () => admin, users: async () => [user('c', 'platform-secret')], log: () => undefined });
  expect(r.restored).toEqual([]);
  expect(calls.some((c) => c[1] === 'SETUSER')).toBe(false);
});

it('does not connect to Redis when no project has Redis credentials', async () => {
  const admin = jest.fn();
  expect(await reconcileProjectRedisUsers({ admin, users: async () => [] })).toEqual({ checked: 0, restored: [] });
  expect(admin).not.toHaveBeenCalled();
});
