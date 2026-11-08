import type { ConfigStore } from '../../../src/lib/config-store';
import {
  getOidcSigningKey,
  getOidcVerificationKeys,
  initOidcSigningKey,
  loadOidcSigningKeyFromStore,
  resetOidcSigningKey,
  rotateOidcSigningKey,
} from '../../../src/lib/oidc-keys';

/** Shared in-memory "Secret" with create-if-not-exists semantics, like KubeSecretStore. */
function memoryStore(shared: { data: Record<string, string> | null }): ConfigStore & { creates: number } {
  return {
    description: 'secret platform/platform-oidc-signing-key',
    creates: 0,
    async read() {
      return { ...(shared.data || {}) };
    },
    async patch(values) {
      shared.data = { ...(shared.data || {}), ...values };
    },
    async createIfAbsent(values) {
      this.creates += 1;
      if (shared.data) return { ...shared.data };
      shared.data = { ...values };
      return { ...values };
    },
  };
}

describe('oidc signing key from a Kubernetes Secret', () => {
  beforeEach(() => {
    delete process.env.OIDC_SIGNING_KEY;
    resetOidcSigningKey();
  });

  it('generates and stores a key when the Secret is absent', async () => {
    const shared = { data: null as Record<string, string> | null };
    const { key } = await loadOidcSigningKeyFromStore(memoryStore(shared));
    expect(key.source).toBe('generated-secret');
    expect(shared.data!['private.pem']).toContain('PRIVATE KEY');
    expect(shared.data!.kid).toBe(key.kid);
  });

  it('two replicas booting together end up with the same key (409 path)', async () => {
    const shared = { data: null as Record<string, string> | null };
    const a = memoryStore(shared);
    const b = memoryStore(shared);
    // Replica B reads "absent" but A creates first: B's createIfAbsent returns A's key.
    const [ka, kb] = await Promise.all([loadOidcSigningKeyFromStore(a), loadOidcSigningKeyFromStore(b)]);
    expect(ka.key.kid).toBe(kb.key.kid);
    expect(ka.key.privateKey).toBe(kb.key.privateKey);
  });

  it('a restart (fresh process state) loads the same key', async () => {
    const shared = { data: null as Record<string, string> | null };
    const first = await initOidcSigningKey(memoryStore(shared));
    resetOidcSigningKey();
    const second = await initOidcSigningKey(memoryStore(shared));
    expect(second.kid).toBe(first.kid);
    expect(second.source).toBe('secret');
    expect(getOidcSigningKey().kid).toBe(first.kid);
  });

  it('rotation keeps the previous key in JWKS/verification set', async () => {
    const shared = { data: null as Record<string, string> | null };
    const store = memoryStore(shared);
    const original = await initOidcSigningKey(store);
    const rotated = await rotateOidcSigningKey(store);
    expect(rotated.kid).not.toBe(original.kid);
    expect(shared.data!['previous-kid']).toBe(original.kid);
    expect(getOidcVerificationKeys().map((k) => k.kid)).toEqual([rotated.kid, original.kid]);

    // Another replica restarting after the rotation sees both keys.
    resetOidcSigningKey();
    await initOidcSigningKey(memoryStore(shared));
    expect(getOidcVerificationKeys().map((k) => k.kid)).toEqual([rotated.kid, original.kid]);
  });

  it('falls back to a local key (never throws) when the Secret is unreachable', async () => {
    const broken: ConfigStore = {
      description: 'secret platform/broken',
      read: async () => {
        throw new Error('forbidden');
      },
      patch: async () => {},
      createIfAbsent: async () => ({}),
    };
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const key = await initOidcSigningKey(broken);
    expect(key.source).not.toMatch(/secret/); // local env/file/memory chain
    err.mockRestore();
  });

  it('OIDC_SIGNING_KEY still wins over the Secret', async () => {
    const shared = { data: null as Record<string, string> | null };
    const seed = await loadOidcSigningKeyFromStore(memoryStore({ data: null }));
    process.env.OIDC_SIGNING_KEY = seed.key.privateKey;
    const store = memoryStore(shared);
    const key = await initOidcSigningKey(store);
    expect(key.source).toBe('env');
    expect(store.creates).toBe(0);
    delete process.env.OIDC_SIGNING_KEY;
  });
});
