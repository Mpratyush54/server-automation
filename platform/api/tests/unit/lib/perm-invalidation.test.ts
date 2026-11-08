/**
 * Issue #18: permission-cache invalidation reaches every replica over Redis pub/sub, and the
 * local cache is bypassed (fail open to the DB) while the subscription is down.
 */
const mockRoleFindOne = jest.fn();
jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({
    getRepository: jest.fn(() => ({ findOne: mockRoleFindOne })),
  }),
}));

import RedisMock from 'ioredis-mock';
import { PermissionInvalidationBus, PERM_INVALIDATE_CHANNEL } from '../../../src/lib/perm-invalidation';
import { setRedisClientForTests } from '../../../src/lib/redis';
import { UserRole } from '../../../src/entities/User';

const waitFor = async (cond: () => boolean, ms = 1000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
  return Date.now() - start;
};

describe('PermissionInvalidationBus', () => {
  it('an invalidation published by one replica reaches the others within 1 s', async () => {
    const redis = new RedisMock();
    const seenA: Array<string | undefined> = [];
    const seenB: Array<string | undefined> = [];
    const podA = new PermissionInvalidationBus((u) => seenA.push(u), async () => redis as any, async () => redis.duplicate() as any);
    const podB = new PermissionInvalidationBus((u) => seenB.push(u), async () => redis.duplicate() as any, async () => redis.duplicate() as any);
    await Promise.all([podA.start(), podB.start()]);
    expect(podA.isReady()).toBe(true);
    expect(podB.isReady()).toBe(true);

    await podA.publish('user-1');
    const elapsed = await waitFor(() => seenB.includes('user-1'));
    expect(elapsed).toBeLessThan(1000);
    expect(seenA).toContain('user-1'); // the publisher clears itself too

    await podB.publish(); // everyone
    await waitFor(() => seenA.includes(undefined));
    await podA.stop();
    await podB.stop();
  });

  it('is not ready (cache bypassed) when Redis cannot be reached, and publish never throws', async () => {
    const bus = new PermissionInvalidationBus(() => {}, () => Promise.reject(new Error('down')), () => Promise.reject(new Error('down')));
    await bus.start();
    expect(bus.isReady()).toBe(false);
    await expect(bus.publish('u')).resolves.toBeUndefined();
  });

  it('drops the local cache when the subscription connection is lost', async () => {
    const redis = new RedisMock();
    const sub = redis.duplicate();
    const seen: Array<string | undefined> = [];
    const bus = new PermissionInvalidationBus((u) => seen.push(u), async () => redis as any, async () => sub as any);
    await bus.start();
    sub.emit('close');
    expect(bus.isReady()).toBe(false);
    expect(seen).toContain(undefined);
    sub.emit('ready');
    expect(bus.isReady()).toBe(true);
  });
});

describe('getUserPermissions with Redis', () => {
  const user = { id: 'u-perm', role: UserRole.VIEWER, roleId: 'role-1' };
  let auth: typeof import('../../../src/middleware/auth');
  let redis: any;

  beforeEach(async () => {
    jest.resetModules();
    redis = new RedisMock();
    // The module copy under test must see the same Redis as this file's publisher.
    require('../../../src/lib/redis').setRedisClientForTests(redis);
    auth = require('../../../src/middleware/auth');
    mockRoleFindOne.mockReset();
    mockRoleFindOne.mockResolvedValue({ permissions: ['projects.read'] });
  });

  afterEach(async () => {
    await auth.permissionInvalidationBus.stop();
    setRedisClientForTests(null);
  });

  it('caches while subscribed and drops the entry when another replica invalidates it', async () => {
    await auth.permissionInvalidationBus.start();
    await auth.getUserPermissions(user);
    await auth.getUserPermissions(user);
    expect(mockRoleFindOne).toHaveBeenCalledTimes(1);

    // Another replica changes the role and publishes.
    mockRoleFindOne.mockResolvedValue({ permissions: ['projects.read', 'projects.write'] });
    await redis.duplicate().publish(PERM_INVALIDATE_CHANNEL, user.id);
    // Takes effect on this replica within 1 s (acceptance criterion).
    const start = Date.now();
    let perms = await auth.getUserPermissions(user);
    while (!perms.has('projects.write') && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 10));
      perms = await auth.getUserPermissions(user);
    }
    expect(perms.has('projects.write')).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('clearPermissionCache publishes on the invalidation channel', async () => {
    const listener = redis.duplicate();
    const got: string[] = [];
    listener.on('message', (_c: string, m: string) => got.push(m));
    await listener.subscribe(PERM_INVALIDATE_CHANNEL);
    auth.clearPermissionCache('abc');
    auth.clearPermissionCache();
    await waitFor(() => got.length >= 2);
    expect(got).toEqual(['abc', '*']);
  });

  it('bypasses the cache (reads the DB every time) while the subscription is not live', async () => {
    require('../../../src/lib/redis').setRedisClientForTests({
      duplicate: () => { throw new Error('down'); },
      publish: () => Promise.reject(new Error('down')),
    });
    await auth.getUserPermissions(user);
    await auth.getUserPermissions(user);
    expect(mockRoleFindOne).toHaveBeenCalledTimes(2);
  });
});
