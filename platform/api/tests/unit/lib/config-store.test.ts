import fs from 'fs';
import os from 'os';
import path from 'path';
import { FileStore, KubeSecretStore, SecretApi, k8sStatusCode, useKubeConfigStore } from '../../../src/lib/config-store';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const apiError = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });

/** In-memory fake of the CoreV1Api secret calls, with resourceVersion CAS. */
function fakeApi(initial?: Record<string, string>) {
  let secret: any = initial
    ? { metadata: { name: 's', namespace: 'platform', resourceVersion: '1' }, data: Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, b64(v)])) }
    : null;
  const api = {
    conflictsLeft: 0,
    readNamespacedSecret: jest.fn(async () => {
      if (!secret) throw apiError(404);
      return JSON.parse(JSON.stringify(secret));
    }),
    replaceNamespacedSecret: jest.fn(async ({ body }: any) => {
      if (api.conflictsLeft > 0) {
        api.conflictsLeft -= 1;
        secret.metadata.resourceVersion = String(Number(secret.metadata.resourceVersion) + 1);
        throw apiError(409);
      }
      if (body.metadata.resourceVersion !== secret.metadata.resourceVersion) throw apiError(409);
      secret = { ...body, metadata: { ...body.metadata, resourceVersion: String(Number(body.metadata.resourceVersion) + 1) } };
      return secret;
    }),
    createNamespacedSecret: jest.fn(async ({ body }: any) => {
      if (secret) throw apiError(409);
      secret = {
        metadata: { ...body.metadata, resourceVersion: '1' },
        data: Object.fromEntries(Object.entries(body.stringData || {}).map(([k, v]) => [k, b64(String(v))])),
      };
      return secret;
    }),
    current: () => secret,
  };
  return api;
}

describe('KubeSecretStore', () => {
  it('reads and decodes Secret data', async () => {
    const api = fakeApi({ POSTGRES_PASSWORD: 'pg' });
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'platform-credentials');
    await expect(store.read()).resolves.toEqual({ POSTGRES_PASSWORD: 'pg' });
  });

  it('returns {} for a missing Secret and creates it on first patch', async () => {
    const api = fakeApi();
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'platform-credentials');
    await expect(store.read()).resolves.toEqual({});
    await store.patch({ REDIS_PASSWORD: 'r', EMPTY: '' });
    expect(api.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const body = api.createNamespacedSecret.mock.calls[0][0].body;
    expect(body.metadata).toMatchObject({ name: 'platform-credentials', namespace: 'platform' });
    expect(body.stringData).toEqual({ REDIS_PASSWORD: 'r' });
  });

  it('merges into existing keys with the read resourceVersion', async () => {
    const api = fakeApi({ KEEP: 'k', POSTGRES_PASSWORD: 'old' });
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'platform-credentials');
    await store.patch({ POSTGRES_PASSWORD: 'new' });
    expect(api.replaceNamespacedSecret.mock.calls[0][0].body.metadata.resourceVersion).toBe('1');
    await expect(store.read()).resolves.toEqual({ KEEP: 'k', POSTGRES_PASSWORD: 'new' });
  });

  it('retries on 409 conflicts by re-reading', async () => {
    const api = fakeApi({ A: '1' });
    api.conflictsLeft = 2;
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'x');
    await store.patch({ B: '2' });
    expect(api.readNamespacedSecret).toHaveBeenCalledTimes(3);
    await expect(store.read()).resolves.toEqual({ A: '1', B: '2' });
  });

  it('gives up after maxAttempts conflicts', async () => {
    const api = fakeApi({ A: '1' });
    api.conflictsLeft = 10;
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'x', 3);
    await expect(store.patch({ B: '2' })).rejects.toThrow(/gave up after 3/);
  });

  it('a create race (409) merges into the winner', async () => {
    const api = fakeApi();
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'x');
    const realCreate = api.createNamespacedSecret.getMockImplementation()!;
    api.createNamespacedSecret.mockImplementationOnce(async () => {
      // another replica created it between our read and our create
      await realCreate({ body: { metadata: { name: 'x', namespace: 'platform' }, stringData: { A: 'theirs' } } });
      throw apiError(409);
    });
    await store.patch({ B: 'mine' });
    expect(decode(api.current().data)).toEqual({ A: 'theirs', B: 'mine' });
  });

  it('createIfAbsent keeps the existing value when another creator won', async () => {
    const api = fakeApi();
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'k');
    await expect(store.createIfAbsent({ K: 'first' })).resolves.toEqual({ K: 'first' });
    await expect(store.createIfAbsent({ K: 'second' })).resolves.toEqual({ K: 'first' });
  });

  it('setIfAbsent creates the Secret, adds a missing key, and never overwrites an existing value', async () => {
    const api = fakeApi();
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'platform-credentials');
    await expect(store.setIfAbsent('K', 'first')).resolves.toBe('first');
    await expect(store.setIfAbsent('K', 'second')).resolves.toBe('first');
    await expect(store.setIfAbsent('OTHER', 'o')).resolves.toBe('o');
    expect(decode(api.current().data)).toEqual({ K: 'first', OTHER: 'o' });
  });

  it('setIfAbsent: a concurrent writer that stored the key first wins (CAS retry)', async () => {
    const api = fakeApi({ A: '1' });
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'platform-credentials');
    const realReplace = api.replaceNamespacedSecret.getMockImplementation()!;
    let raced = false;
    api.replaceNamespacedSecret.mockImplementation(async (args: any) => {
      if (!raced) {
        raced = true;
        // Another replica stores its key between our read and our replace.
        const cur = api.current();
        await realReplace({ body: { ...cur, data: { ...cur.data, K: b64('theirs') } } } as any);
      }
      return realReplace(args);
    });
    await expect(store.setIfAbsent('K', 'mine')).resolves.toBe('theirs');
    expect(decode(api.current().data)).toEqual({ A: '1', K: 'theirs' });
  });

  it('propagates non-404/409 errors (e.g. RBAC 403)', async () => {
    const api = fakeApi();
    api.readNamespacedSecret.mockRejectedValue(apiError(403));
    const store = new KubeSecretStore(api as unknown as SecretApi, 'platform', 'x');
    await expect(store.read()).rejects.toThrow('HTTP 403');
    await expect(store.patch({ A: '1' })).rejects.toThrow('HTTP 403');
  });
});

function decode(data: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')]));
}

describe('k8sStatusCode', () => {
  it('understands client-node 0.x and 1.x error shapes, ignores errno strings', () => {
    expect(k8sStatusCode({ code: 404 })).toBe(404);
    expect(k8sStatusCode({ statusCode: 409 })).toBe(409);
    expect(k8sStatusCode({ response: { statusCode: 403 } })).toBe(403);
    expect(k8sStatusCode({ code: 'ECONNREFUSED' })).toBeUndefined();
  });
});

describe('FileStore', () => {
  it('round-trips dotenv values and per-key credential files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgstore-'));
    const envFile = path.join(root, '.env');
    fs.writeFileSync(envFile, 'KEEP=1\n# comment\nQUOTED="a b"\n');
    const store = new FileStore(envFile, { credDir: path.join(root, 'credentials'), keyFiles: { POSTGRES_PASSWORD: 'postgres', POSTGRES_PASSWORD_PREV: 'postgres.prev' }, envKeys: ['POSTGRES_PASSWORD'] });
    await store.patch({ POSTGRES_PASSWORD: 'pg', POSTGRES_PASSWORD_PREV: 'old' });
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text).toContain('KEEP=1');
    expect(text).toContain('POSTGRES_PASSWORD=pg');
    expect(text).not.toContain('POSTGRES_PASSWORD_PREV');
    expect(fs.readFileSync(path.join(root, 'credentials', 'postgres.prev'), 'utf8').trim()).toBe('old');
    await expect(store.read()).resolves.toMatchObject({ KEEP: '1', QUOTED: 'a b', POSTGRES_PASSWORD: 'pg', POSTGRES_PASSWORD_PREV: 'old' });
  });

  it('setIfAbsent writes a missing key once and keeps an existing value', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgstore-'));
    const store = new FileStore(path.join(root, '.env'));
    await expect(store.setIfAbsent('K', 'first')).resolves.toBe('first');
    await expect(store.setIfAbsent('K', 'second')).resolves.toBe('first');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('K=first');
  });
});

describe('useKubeConfigStore', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('is off under tests even inside a pod, unless forced', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    process.env.NODE_ENV = 'test';
    delete process.env.PLATFORM_CONFIG_STORE;
    expect(useKubeConfigStore()).toBe(false);
    process.env.PLATFORM_CONFIG_STORE = 'kube';
    expect(useKubeConfigStore()).toBe(true);
  });
  it('is on in a pod in production', () => {
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    process.env.NODE_ENV = 'production';
    delete process.env.PLATFORM_CONFIG_STORE;
    expect(useKubeConfigStore()).toBe(true);
    process.env.PLATFORM_CONFIG_STORE = 'file';
    expect(useKubeConfigStore()).toBe(false);
  });
});
