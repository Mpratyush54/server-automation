jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-admin'),
  compare: jest.fn().mockResolvedValue(true),
}));

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

const saveUser = jest.fn().mockImplementation((u: any) => {
  (globalThis as any).__rotateOrder?.push('saveUser');
  return Promise.resolve(u);
});
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

import fs from 'fs';
import os from 'os';
import path from 'path';

describe('secret-rotate', () => {
  let rotatePlatformSecrets: (opts: { actorUserId?: string }) => Promise<{ results: any[]; values: Record<string, string> }>;

  beforeAll(async () => {
    ({ rotatePlatformSecrets } = await import('../../../src/lib/secret-rotate'));
  });
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

    // Admin hashes are written before ALTER USER changes the password the DB pool uses.
    // (Notifications now go through the outbox after the steps commit, so later getDb
    // calls are expected.)
    const order: string[] = (globalThis as any).__rotateOrder;
    const lastSaveUser = order.lastIndexOf('saveUser');
    const firstPg = order.indexOf('pgConnect');
    expect(lastSaveUser).toBeGreaterThanOrEqual(0);
    expect(firstPg).toBeGreaterThanOrEqual(0);
    expect(lastSaveUser).toBeLessThan(firstPg);
    expect(saveNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Platform secrets rotated' }));

    const pgSecret = patchSecretData.mock.calls.find(([ns, name]) => ns === 'databases' && name === 'postgresql');
    expect(pgSecret).toBeTruthy();
    expect(pgSecret[2]['postgres-password']).toBe(result.values.POSTGRES_PASSWORD);

    // platform-env carries only non-credential config now.
    const envPatch = patchSecretData.mock.calls.find(([ns, name]) => ns === 'platform' && name === 'platform-env');
    expect(envPatch[2]).toEqual({ PLATFORM_WEBHOOK_SECRET: result.values.PLATFORM_WEBHOOK_SECRET });

    // Credentials go to the credentials store (FileStore under tests).
    const credDir = process.env.PLATFORM_CRED_DIR!;
    expect(fs.readFileSync(path.join(credDir, 'postgres'), 'utf8').trim()).toBe(result.values.POSTGRES_PASSWORD);
    expect(fs.readFileSync(path.join(credDir, 'redis'), 'utf8').trim()).toBe(result.values.REDIS_PASSWORD);
    expect(fs.readFileSync(path.join(credDir, 'postgres.prev'), 'utf8').trim()).toBe('old-pg');

    expect(upsertSecretData).toHaveBeenCalledWith(
      'platform',
      'platform-rotate-pending',
      expect.objectContaining({ POSTGRES_PASSWORD_OLD: 'old-pg' }),
    );
    expect(result.results.some((r) => r.key === 'credentials:platform-credentials' && r.ok)).toBe(true);
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
    expect(fs.existsSync(path.join(process.env.PLATFORM_CRED_DIR!, 'postgres'))).toBe(false);
  });

  it('does not patch redis secrets when CONFIG SET requirepass fails', async () => {
    (globalThis as any).__SECRET_ROTATE_REDIS_FAIL = true;

    const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });

    expect(result.values).not.toHaveProperty('REDIS_PASSWORD');
    expect(result.results.some((r) => r.key === 'REDIS_PASSWORD' && !r.ok)).toBe(true);

    const redisSecret = patchSecretData.mock.calls.find(([ns, name]) => ns === 'databases' && name === 'redis');
    expect(redisSecret).toBeUndefined();

    const credDir = process.env.PLATFORM_CRED_DIR!;
    expect(fs.existsSync(path.join(credDir, 'redis'))).toBe(false);
    expect(fs.readFileSync(path.join(credDir, 'postgres'), 'utf8').trim()).toBe(result.values.POSTGRES_PASSWORD);
  });

  it('writes previous/next passwords to the platform-credentials Secret before ALTER USER in the cluster', async () => {
    const { setSecretApiForTests } = await import('../../../src/lib/config-store');
    const stored: Record<string, string> = {};
    let rv = 1;
    const api = {
      readNamespacedSecret: jest.fn(async ({ name }: any) => {
        if (name !== 'platform-credentials') throw Object.assign(new Error('not found'), { code: 404 });
        const data: Record<string, string> = {};
        for (const [k, v] of Object.entries(stored)) data[k] = Buffer.from(v).toString('base64');
        return { metadata: { name, resourceVersion: String(rv) }, data };
      }),
      replaceNamespacedSecret: jest.fn(async ({ body }: any) => {
        (globalThis as any).__rotateOrder.push(`credentials:${Object.keys(body.data).sort().join(',')}`);
        for (const [k, v] of Object.entries(body.data)) stored[k] = Buffer.from(String(v), 'base64').toString('utf8');
        rv += 1;
      }),
      createNamespacedSecret: jest.fn(),
    };
    process.env.PLATFORM_CONFIG_STORE = 'kube';
    setSecretApiForTests(api);
    try {
      const result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });
      const order: string[] = (globalThis as any).__rotateOrder;
      const firstWrite = order.findIndex((o) => o.startsWith('credentials:') && o.includes('POSTGRES_PASSWORD_NEXT'));
      expect(firstWrite).toBeGreaterThanOrEqual(0);
      expect(firstWrite).toBeLessThan(order.indexOf('pgConnect'));
      expect(stored.POSTGRES_PASSWORD_PREV).toBe('old-pg');
      expect(stored.POSTGRES_PASSWORD).toBe(result.values.POSTGRES_PASSWORD);
      expect(stored.REDIS_PASSWORD).toBe(result.values.REDIS_PASSWORD);
      expect(stored.ADMIN_PASSWORD).toBe(result.values.ADMIN_PASSWORD);
    } finally {
      delete process.env.PLATFORM_CONFIG_STORE;
      setSecretApiForTests(null);
    }
  });

  it('refuses ALTER USER when neither the credentials store nor pending secret can be written', async () => {
    upsertSecretData.mockRejectedValue(new Error('forbidden'));
    // Make every host-file write fail (EACCES) on any OS, instead of relying on /proc
    // being unwritable (it is just a normal path on Windows).
    const envFile = process.env.PLATFORM_ENV_FILE!;
    const credDir = process.env.PLATFORM_CRED_DIR!;
    const denied = (target: unknown) => {
      const t = path.resolve(String(target));
      return t === path.resolve(envFile) || t.startsWith(path.resolve(path.dirname(envFile)) + path.sep) || t.startsWith(path.resolve(credDir));
    };
    const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const realWrite = fs.writeFileSync;
    const realMkdir = fs.mkdirSync;
    const realRename = fs.renameSync;
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, ...rest: any[]) => {
      if (denied(file)) throw eacces();
      return (realWrite as any)(file, ...rest);
    }) as any);
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockImplementation(((dir: any, ...rest: any[]) => {
      if (denied(dir)) throw eacces();
      return (realMkdir as any)(dir, ...rest);
    }) as any);
    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(((from: any, to: any) => {
      if (denied(to)) throw eacces();
      return (realRename as any)(from, to);
    }) as any);

    let result: { results: any[]; values: Record<string, string> };
    try {
      result = await rotatePlatformSecrets({ actorUserId: 'admin-1' });
      expect(writeSpy.mock.calls.some(([f]) => denied(f)) || mkdirSpy.mock.calls.some(([d]) => denied(d))).toBe(true);
    } finally {
      writeSpy.mockRestore();
      mkdirSpy.mockRestore();
      renameSpy.mockRestore();
    }

    expect(result.values).not.toHaveProperty('POSTGRES_PASSWORD');
    expect(result.results.some((r) => /refused ALTER USER/.test(r.detail))).toBe(true);
    const order: string[] = (globalThis as any).__rotateOrder;
    expect(order).not.toContain('pgConnect');
  });

  it('records a step log and refuses a concurrent rotation with LockBusyError', async () => {
    const { acquireLock } = await import('../../../src/lib/locks');
    const { getOperation } = await import('../../../src/lib/operations');
    const held = await acquireLock('lock:platform:secret-rotation', { holder: 'op-running' });
    await expect(rotatePlatformSecrets({ actorUserId: 'admin-1' })).rejects.toMatchObject({ name: 'LockBusyError', holder: 'op-running' });
    await held!.release();

    const result: any = await rotatePlatformSecrets({ actorUserId: 'admin-1' });
    expect(result.status).toBe('succeeded');
    const op = await getOperation(result.operationId);
    expect(op!.steps.map((s) => s.name)).toEqual([
      'admin-password', 'write-ahead', 'redis-password', 'postgres-password',
      'patch-secrets', 'argocd-password', 'finalize', 'restart-api',
    ]);
    expect(op!.steps.every((s) => s.status === 'succeeded')).toBe(true);
    // credentials never stay in the step log
    expect(JSON.stringify(op)).not.toContain(result.values.POSTGRES_PASSWORD);
    expect(op!.state).toEqual({});
  });

  describe('resume after the API was killed mid-rotation', () => {
    const NEW_PG = 'new-pg-password';
    const NEW_REDIS = 'new-redis-password';

    async function crashedRotation(atStep: string) {
      const ops = await import('../../../src/lib/operations');
      const { SECRET_ROTATION_OPERATION, SECRET_ROTATION_LOCK_KEY } = await import('../../../src/lib/secret-rotate');
      const store = await ops.resolveOperationStore();
      const rec = await ops.createOperation(SECRET_ROTATION_OPERATION, {
        lockKey: SECRET_ROTATION_LOCK_KEY,
        state: {
          actorUserId: 'admin-1', admin: 'new-admin', webhook: 'new-webhook', postgres: NEW_PG,
          redisPassword: NEW_REDIS, argocd: 'new-argocd', previousPostgres: 'old-pg', previousRedis: 'old-redis',
          adminOk: true, redisOk: true, pgOk: false, results: [], values: { ADMIN_PASSWORD: 'new-admin' },
        } as any,
      });
      await store.claim(rec.id, 'm:killed-pod');
      const cur = (await store.get(rec.id))!;
      const idx = cur.steps.findIndex((s) => s.name === atStep);
      cur.status = 'running';
      cur.currentStep = idx;
      for (let i = 0; i < idx; i++) cur.steps[i].status = 'succeeded';
      cur.steps[idx].status = 'running';
      cur.steps[idx].attempts = 1;
      await store.save(cur, 'm:killed-pod');
      return { id: rec.id, ops };
    }

    it('re-checks the in-flight ALTER USER, then patches secrets, clears pending and restarts', async () => {
      const { id, ops } = await crashedRotation('postgres-password');
      const { resumed } = await ops.resumeOperations();
      expect(resumed).toContain(id);
      await ops.waitForActiveRuns();
      const op = (await ops.getOperation(id))!;
      expect(op.status).toBe('succeeded');
      expect(op.attempts).toBe(2);
      const pgStep = op.steps.find((s) => s.name === 'postgres-password')!;
      expect(pgStep.attempts).toBe(2);
      expect(JSON.stringify(pgStep.output)).toContain('already rotated before the interruption');
      const pgSecret = patchSecretData.mock.calls.find(([ns, name]) => ns === 'databases' && name === 'postgresql');
      expect(pgSecret[2]['postgres-password']).toBe(NEW_PG);
      // #20: platform-env keeps only non-credential config; the resumed postgres step writes
      // the new password to the credentials store (FileStore under tests).
      const envPatch = patchSecretData.mock.calls.find(([ns, name]) => ns === 'platform' && name === 'platform-env');
      expect(envPatch[2]).toEqual({ PLATFORM_WEBHOOK_SECRET: 'new-webhook' });
      expect(fs.readFileSync(path.join(process.env.PLATFORM_CRED_DIR!, 'postgres'), 'utf8').trim()).toBe(NEW_PG);
      expect(JSON.stringify(pgStep.output)).toContain('platform-credentials:POSTGRES_PASSWORD');
      expect(deleteSecret).toHaveBeenCalledWith('platform', 'platform-rotate-pending');
      expect(restartNamedDeployment).toHaveBeenCalledWith('platform', 'platform-api');
      expect(reconnectPostgres).toHaveBeenCalledWith(NEW_PG);
      expect(op.state).toEqual({});
    });

    it('does not restart the API again when it died during the restart step', async () => {
      const { id, ops } = await crashedRotation('restart-api');
      await ops.runOperation(id);
      const op = (await ops.getOperation(id))!;
      expect(op.status).toBe('succeeded');
      expect(op.steps.find((s) => s.name === 'restart-api')!.status).toBe('skipped');
      expect(restartNamedDeployment).not.toHaveBeenCalled();
    });
  });
});
