/**
 * RedisManager: per-project ACL credentials are passed to ioredis, and connection errors are
 * handled by a listener (never "Unhandled error event").
 */
const mockInstances: any[] = [];
let mockConnectOk = false;
jest.mock('ioredis', () => {
  const { EventEmitter } = require('events');
  class MockRedis extends EventEmitter {
    opts: any;
    constructor(opts: any) { super(); this.opts = opts; mockInstances.push(this); }
    connect = jest.fn(async () => {
      if (mockConnectOk) return;
      // Real ioredis emits 'error' on the client and rejects connect().
      const err = new Error('connect ECONNREFUSED 127.0.0.1:6379');
      this.emit('error', err);
      throw err;
    });
    disconnect = jest.fn();
    quit = jest.fn(async () => 'OK');
  }
  return { __esModule: true, default: MockRedis };
});

import { RedisManager } from '../../../src/db/redis';

describe('RedisManager', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    mockInstances.length = 0;
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { errSpy.mockRestore(); mockConnectOk = false; });

  it('passes the ACL username, key prefix and db from Platform credentials', async () => {
    const m = new RedisManager({ host: 'redis', port: 6380, username: 'plat_a_b', password: 'pw', keyPrefix: 'plat:a:b:', db: 0 });
    await m.connect();
    await m.disconnect();
    expect(mockInstances[0].opts).toMatchObject({ host: 'redis', port: 6380, username: 'plat_a_b', password: 'pw', keyPrefix: 'plat:a:b:', db: 0, lazyConnect: true });
  });

  it('attaches an error listener so connection failures are not unhandled error events', async () => {
    const m = new RedisManager({ host: 'redis' });
    // EventEmitter throws on 'error' without a listener; connect() must still resolve.
    await expect(m.connect()).resolves.toBeUndefined();
    expect(mockInstances[0].listenerCount('error')).toBeGreaterThan(0);
    expect(m.isConnected).toBe(false);
    await m.disconnect();
  });

  it('reports connected again when ioredis recovers after a Redis restart', async () => {
    mockConnectOk = true;
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const m = new RedisManager({ host: 'redis' });
    await m.connect();
    expect(m.isConnected).toBe(true);
    const client = mockInstances[0];
    // Established connection drops (and AUTH fails until the ACL user is back) ...
    client.emit('error', new Error('WRONGPASS invalid username-password pair'));
    expect(m.isConnected).toBe(false);
    // ... then ioredis reconnects by itself and emits 'ready'.
    client.emit('ready');
    expect(m.isConnected).toBe(true);
    await m.disconnect();
    logSpy.mockRestore();
  });
});
