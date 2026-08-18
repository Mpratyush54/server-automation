jest.mock('pg', () => {
  return {
    Client: class {
      connect = jest.fn().mockImplementation(() => {
        (globalThis as any).__rotateOrder?.push('pgConnect');
        if ((globalThis as any).__SECRET_ROTATE_PG_FAIL) {
          return Promise.reject(new Error('password authentication failed for user "postgres"'));
        }
        return Promise.resolve();
      });
      query = jest.fn().mockResolvedValue({ rowCount: 1 });
      end = jest.fn().mockResolvedValue(undefined);
    },
  };
});

jest.mock('ioredis', () => ({
  __esModule: true,
  default: class {
    connect = jest.fn().mockImplementation(() => {
      (globalThis as any).__rotateOrder?.push('redisConnect');
      if ((globalThis as any).__SECRET_ROTATE_REDIS_FAIL) {
        return Promise.reject(new Error('WRONGPASS invalid username-password pair'));
      }
      return Promise.resolve();
    });
    config = jest.fn().mockResolvedValue('OK');
    auth = jest.fn().mockResolvedValue('OK');
    disconnect = jest.fn();
  },
}));

const patchSecretData = jest.fn().mockResolvedValue(undefined);
const restartNamedDeployment = jest.fn().mockResolvedValue(undefined);
const upsertSecretData = jest.fn().mockResolvedValue(undefined);
const deleteSecret = jest.fn().mockResolvedValue(undefined);
const readSecretData = jest.fn().mockResolvedValue({});

jest.mock('../../../src/lib/k8s', () => ({
  patchSecretData: (...args: any[]) => patchSecretData(...args),
  restartNamedDeployment: (...args: any[]) => restartNamedDeployment(...args),
  upsertSecretData: (...args: any[]) => upsertSecretData(...args),
  deleteSecret: (...args: any[]) => deleteSecret(...args),
  readSecretData: (...args: any[]) => readSecretData(...args),
}));

const saveUser = jest.fn().mockImplementation((u: any) => Promise.resolve(u));
const saveNotification = jest.fn().mockImplementation((n: any) => Promise.resolve(n));
const reconnectPostgres = jest.fn().mockResolvedValue({});

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockImplementation(async () => {
    (globalThis as any).__rotateOrder?.push('getDb');
    return {
      getRepository: (entity: any) => {
        const name = entity?.name;
        if (name === 'User') {
          return {
            find: jest.fn().mockResolvedValue([{ id: 'admin-1', role: 'admin', passwordHash: 'old' }]),
            save: saveUser,
          };
        }
        if (name === 'Notification') {
          return {
            create: jest.fn().mockImplementation((d: any) => d),
            save: saveNotification,
          };
        }
        return { find: jest.fn().mockResolvedValue([]), save: jest.fn(), create: jest.fn() };
      },
    };
  }),
  reconnectPostgres: (...args: any[]) => reconnectPostgres(...args),
  isPostgresAuthError: (err: any) => /password authentication failed/i.test(String(err?.message || err || '')),
}));

import { rotatePlatformSecrets } from '../../../src/lib/secret-rotate';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('secret-rotate', () => {
  beforeEach(() => {
    patchSecretData.mockClear();
    restartNamedDeployment.mockClear();
    upsertSecretData.mockReset().mockResolvedValue(undefined);
    deleteSecret.mockClear();
    reconnectPostgres.mockClear();
    saveUser.mockClear();
    (globalThis as any).__rotateOrder = [];
    delete (globalThis as any).__SECRET_ROTATE_PG_FAIL;
    delete (globalThis as any).__SECRET_ROTATE_REDIS_FAIL;
    process.env.POSTGRES_USER = 'postgres';
    process.env.POSTGRES_PASSWORD = 'old-pg';
    process.env.REDIS_PASSWORD = 'old-redis';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plat-rotate-'));
    process.env.PLATFORM_ENV_FILE = path.join(tmp, '.env');
    process.env.PLATFORM_CRED_DIR = path.join(tmp, 'credentials');
    fs.writeFileSync(process.env.PLATFORM_ENV_FILE, 'POSTGRES_PASSWORD=old-pg\n');
  });

  it('updates admin hashes before ALTER USER, then patches postgres/redis secrets and restarts only the API', async () => {
    const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });

    expect(result.values.ADMIN_PASSWORD).toBeTruthy();
    expect(result.values.POSTGRES_PASSWORD).toBeTruthy();
    expect(result.values.REDIS_PASSWORD).toBeTruthy();
    expect(result.values.PLATFORM_WEBHOOK_SECRET).toBeTruthy();
    expect(result.values.ARGOCD_ADMIN_PASSWORD).toBeTruthy();
    expect(result.values).not.toHaveProperty('JWT_SECRET');
    expect(result.values).not.toHaveProperty('MONGO_PASSWORD');
    expect(result.values).not.toHaveProperty('MINIO_SECRET_KEY');
    expect(result.values).not.toHaveProperty('PORTAINER_ADMIN_PASSWORD');
    expect(saveUser).toHaveBeenCalled();
    expect(result.results.some((r) => r.key === 'ADMIN_PASSWORD' && r.ok)).toBe(true);

    const order: string[] = (globalThis as any).__rotateOrder;
    const lastGetDb = order.lastIndexOf('getDb');
    const firstPg = order.indexOf('pgConnect');
    expect(lastGetDb).toBeGreaterThanOrEqual(0);
    expect(firstPg).toBeGreaterThanOrEqual(0);
    expect(lastGetDb).toBeLessThan(firstPg);

    const pgSecret = patchSecretData.mock.calls.find(([ns, name]) => ns === 'databases' && name === 'postgresql');
    expect(pgSecret).toBeTruthy();
    expect(pgSecret[2]['postgres-password']).toBe(result.values.POSTGRES_PASSWORD);

    const envPatch = patchSecretData.mock.calls.find(([ns, name]) => ns === 'platform' && name === 'platform-env');
    expect(envPatch[2].POSTGRES_PASSWORD).toBe(result.values.POSTGRES_PASSWORD);
    expect(envPatch[2].REDIS_PASSWORD).toBe(result.values.REDIS_PASSWORD);
    expect(envPatch[2]).not.toHaveProperty('MONGO_PASSWORD');
    expect(envPatch[2]).not.toHaveProperty('MINIO_SECRET_KEY');

    expect(upsertSecretData).toHaveBeenCalledWith(
      'platform',
      'platform-rotate-pending',
      expect.objectContaining({ POSTGRES_PASSWORD_OLD: 'old-pg' }),
    );
    expect(result.results.some((r) => r.key === 'host:/etc/platform')).toBe(true);
    expect(reconnectPostgres).toHaveBeenCalled();
    expect(deleteSecret).toHaveBeenCalledWith('platform', 'platform-rotate-pending');

    expect(restartNamedDeployment).toHaveBeenCalledWith('platform', 'platform-api');
    expect(restartNamedDeployment).not.toHaveBeenCalledWith('databases', 'postgresql');
    expect(restartNamedDeployment).not.toHaveBeenCalledWith('storage', 'minio');
  });

  it('does not patch the postgresql secret or platform-env POSTGRES_PASSWORD when ALTER USER fails', async () => {
    (globalThis as any).__SECRET_ROTATE_PG_FAIL = true;

    const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });

    expect(result.values).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(result.results.some((r) => r.key === 'POSTGRES_PASSWORD' && !r.ok)).toBe(true);
    expect(result.results.some((r) => r.key === 'databases/postgresql' && !r.ok)).toBe(true);

    const pgSecret = patchSecretData.mock.calls.find(([ns, name]) => ns === 'databases' && name === 'postgresql');
    expect(pgSecret).toBeUndefined();

    const envPatch = patchSecretData.mock.calls.find(([ns, name]) => ns === 'platform' && name === 'platform-env');
    expect(envPatch).toBeTruthy();
    expect(envPatch[2]).not.toHaveProperty('POSTGRES_PASSWORD');
  });

  it('does not patch redis secrets when CONFIG SET requirepass fails', async () => {
    (globalThis as any).__SECRET_ROTATE_REDIS_FAIL = true;

    const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });

    expect(result.values).not.toHaveProperty('REDIS_PASSWORD');
    expect(result.results.some((r) => r.key === 'REDIS_PASSWORD' && !r.ok)).toBe(true);

    const redisSecret = patchSecretData.mock.calls.find(([ns, name]) => ns === 'databases' && name === 'redis');
    expect(redisSecret).toBeUndefined();

    const envPatch = patchSecretData.mock.calls.find(([ns, name]) => ns === 'platform' && name === 'platform-env');
    expect(envPatch[2]).not.toHaveProperty('REDIS_PASSWORD');
    expect(envPatch[2]).toHaveProperty('POSTGRES_PASSWORD');
  });

  it('refuses ALTER USER when neither host files nor pending secret can be written', async () => {
    upsertSecretData.mockRejectedValue(new Error('forbidden'));
    process.env.PLATFORM_ENV_FILE = '/proc/platformctl-nope.env';
    process.env.PLATFORM_CRED_DIR = '/proc/platformctl-nope-creds';

    const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });

    expect(result.values).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(result.results.some((r) => /refused ALTER USER/.test(r.detail))).toBe(true);
    const order: string[] = (globalThis as any).__rotateOrder;
    expect(order).not.toContain('pgConnect');
  });
});
