jest.mock('pg', () => ({
  Client: class {
    password: string;
    constructor(opts: { password?: string }) {
      this.password = opts.password || '';
    }
    connect = jest.fn().mockImplementation(() => {
      if (this.password === 'working-pg') return Promise.resolve();
      return Promise.reject(new Error('password authentication failed for user "postgres"'));
    });
    end = jest.fn().mockResolvedValue(undefined);
  },
}));

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    password: string | undefined;
    constructor(opts: { password?: string }) {
      this.password = opts.password;
    }
    connect = jest.fn().mockImplementation(() => {
      if (this.password === 'working-redis') return Promise.resolve();
      return Promise.reject(new Error('WRONGPASS invalid username-password pair'));
    });
    ping = jest.fn().mockResolvedValue('PONG');
    disconnect = jest.fn();
  },
}));

const readSecretData = jest.fn();
const patchSecretData = jest.fn().mockResolvedValue(undefined);
const upsertSecretData = jest.fn().mockResolvedValue(undefined);
const deleteSecret = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../src/lib/k8s', () => ({
  readSecretData: (...args: any[]) => readSecretData(...args),
  patchSecretData: (...args: any[]) => patchSecretData(...args),
  upsertSecretData: (...args: any[]) => upsertSecretData(...args),
  deleteSecret: (...args: any[]) => deleteSecret(...args),
}));

const reconnectPostgres = jest.fn().mockResolvedValue({});

jest.mock('../../../src/config/database', () => ({
  reconnectPostgres: (...args: any[]) => reconnectPostgres(...args),
  getDb: jest.fn(),
}));

import { recoverPostgresAuth, recoverRedisAuth } from '../../../src/lib/credential-recover';

describe('credential-recover', () => {
  beforeEach(() => {
    readSecretData.mockReset();
    patchSecretData.mockClear();
    reconnectPostgres.mockClear();
    process.env.POSTGRES_PASSWORD = 'stale-pg';
    process.env.REDIS_PASSWORD = 'stale-redis';
    readSecretData.mockImplementation(async () => ({}));
  });

  it('reconnects postgres using the Bitnami secret when env is stale and syncs platform-env', async () => {
    readSecretData.mockImplementation(async (namespace: string, name: string) => {
      if (namespace === 'databases' && name === 'postgresql') {
        return { 'postgres-password': 'working-pg' };
      }
      return {};
    });

    const result = await recoverPostgresAuth();

    expect(result.ok).toBe(true);
    expect(result.source).toBe('postgresql-secret');
    expect(reconnectPostgres).toHaveBeenCalledWith('working-pg');
    expect(patchSecretData).toHaveBeenCalledWith('platform', 'platform-env', {
      POSTGRES_PASSWORD: 'working-pg',
    });
    expect(patchSecretData).toHaveBeenCalledWith('databases', 'postgresql', {
      'postgres-password': 'working-pg',
      password: 'working-pg',
    });
    expect(process.env.POSTGRES_PASSWORD).toBe('working-pg');
  });

  it('prefers the write-ahead pending new password when that copy still authenticates', async () => {
    readSecretData.mockImplementation(async (namespace: string, name: string) => {
      if (namespace === 'platform' && name === 'platform-rotate-pending') {
        return { POSTGRES_PASSWORD_NEW: 'working-pg', POSTGRES_PASSWORD_OLD: 'stale-pg' };
      }
      return {};
    });

    const result = await recoverPostgresAuth();

    expect(result.ok).toBe(true);
    expect(result.source).toBe('pending-new');
    expect(reconnectPostgres).toHaveBeenCalledWith('working-pg');
  });

  it('returns not ok when no stored postgres password authenticates', async () => {
    const result = await recoverPostgresAuth();
    expect(result.ok).toBe(false);
    expect(reconnectPostgres).not.toHaveBeenCalled();
  });

  it('heals redis WRONGPASS from the redis secret without requiring SSH', async () => {
    readSecretData.mockImplementation(async (namespace: string, name: string) => {
      if (namespace === 'databases' && name === 'redis') {
        return { 'redis-password': 'working-redis' };
      }
      return {};
    });

    const result = await recoverRedisAuth();

    expect(result.ok).toBe(true);
    expect(result.source).toBe('redis-secret');
    expect(patchSecretData).toHaveBeenCalledWith('platform', 'platform-env', {
      REDIS_PASSWORD: 'working-redis',
    });
  });
});
