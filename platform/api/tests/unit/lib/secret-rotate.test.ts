jest.mock('pg', () => {
  return {
    Client: class {
      connect = jest.fn().mockResolvedValue(undefined);
      query = jest.fn().mockResolvedValue({ rowCount: 1 });
      end = jest.fn().mockResolvedValue(undefined);
    },
  };
});

const patchSecretData = jest.fn().mockResolvedValue(undefined);
const restartNamedDeployment = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../src/lib/k8s', () => ({
  patchSecretData: (...args: any[]) => patchSecretData(...args),
  restartNamedDeployment: (...args: any[]) => restartNamedDeployment(...args),
}));

const saveUser = jest.fn().mockImplementation((u: any) => Promise.resolve(u));
const saveNotification = jest.fn().mockImplementation((n: any) => Promise.resolve(n));

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({
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
  }),
}));

import { rotatePlatformSecrets } from '../../../src/lib/secret-rotate';

describe('secret-rotate', () => {
  beforeEach(() => {
    patchSecretData.mockClear();
    restartNamedDeployment.mockClear();
    saveUser.mockClear();
    process.env.POSTGRES_USER = 'plat';
    process.env.POSTGRES_PASSWORD = 'old-pg';
  });

  it('rotates admin, datastore, webhook, portainer and argocd secrets', async () => {
    const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });
    expect(result.values.ADMIN_PASSWORD).toBeTruthy();
    expect(result.values.POSTGRES_PASSWORD).toBeTruthy();
    expect(result.values.REDIS_PASSWORD).toBeTruthy();
    expect(result.values.MONGO_PASSWORD).toBeTruthy();
    expect(result.values.MINIO_SECRET_KEY).toBeTruthy();
    expect(result.values.PLATFORM_WEBHOOK_SECRET).toBeTruthy();
    expect(result.values.PORTAINER_ADMIN_PASSWORD).toBeTruthy();
    expect(result.values.ARGOCD_ADMIN_PASSWORD).toBeTruthy();
    expect(result.values).not.toHaveProperty('JWT_SECRET');
    expect(patchSecretData).toHaveBeenCalled();
    expect(saveUser).toHaveBeenCalled();
    expect(result.results.some((r) => r.key === 'ADMIN_PASSWORD' && r.ok)).toBe(true);
  });
});
