import {
  INGEST_SIGNING_KEY_NAME,
  initIngestSigningKey,
  issueIngestToken,
  normalizeOrigin,
  originAllowed,
  scopeForPath,
  setIngestKeyStoreForTests,
  setIngestSigningKeyForTests,
  tokenTypeAllowedFor,
  verifyIngestToken,
} from '../../../src/lib/telemetry-tokens';
import type { ConfigStore } from '../../../src/lib/config-store';

const PID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = 'k'.repeat(64);
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

beforeEach(() => {
  delete process.env[INGEST_SIGNING_KEY_NAME];
  delete process.env.TELEMETRY_INGEST_SIGNING_KEY_PREVIOUS;
  delete process.env.TELEMETRY_INGEST_TOKEN_TTL_SECONDS;
  setIngestKeyStoreForTests(undefined);
  setIngestSigningKeyForTests(KEY);
});

function b64json(o: unknown) {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

describe('issue / verify', () => {
  it('round-trips a server token with project + environment scope and a 24 h default lifetime', async () => {
    const { token, expiresAt } = await issueIngestToken({ projectId: PID, environment: 'production', type: 'server', now: NOW });
    expect(token.startsWith('plat_ingest_')).toBe(true);
    expect(token.startsWith('plat_ingest_web_')).toBe(false);
    const life = expiresAt.getTime() - NOW;
    expect(life).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(life).toBeGreaterThan(23 * 3600 * 1000);
    const r = await verifyIngestToken(token, NOW);
    expect(r).toEqual({ ok: true, claims: expect.objectContaining({ typ: 'server', projectId: PID, environment: 'production', origins: [] }) });
  });

  it('round-trips a browser token carrying its normalised origins', async () => {
    const { token } = await issueIngestToken({
      projectId: PID, environment: 'staging', type: 'web', now: NOW,
      origins: ['https://App.Example.org/', 'shop.example.org', 'javascript:alert(1)', 'https://*.cdn.example.org'],
    });
    expect(token.startsWith('plat_ingest_web_')).toBe(true);
    const r = await verifyIngestToken(token, NOW);
    expect(r.ok && r.claims.typ).toBe('web');
    expect(r.ok && r.claims.origins).toEqual(['https://*.cdn.example.org', 'https://app.example.org', 'https://shop.example.org']);
  });

  it('returns the same token for repeated issues within the alignment window (auth-cache friendly)', async () => {
    const a = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'server', now: NOW });
    const b = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'server', now: NOW + 60_000 });
    expect(a.token).toBe(b.token);
  });

  it('rejects expired tokens', async () => {
    const { token, expiresAt } = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'server', ttlSeconds: 600, now: NOW });
    expect((await verifyIngestToken(token, expiresAt.getTime() - 1000)).ok).toBe(true);
    expect(await verifyIngestToken(token, expiresAt.getTime())).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a tampered payload (e.g. another project) and a tampered signature', async () => {
    const { token } = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'server', now: NOW });
    const [body, sig] = token.slice('plat_ingest_'.length).split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = `plat_ingest_${b64json({ ...claims, pid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })}.${sig}`;
    expect(await verifyIngestToken(forged, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(await verifyIngestToken(`plat_ingest_${body}.${flipped}`, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('cannot turn a browser token into a server token by swapping the prefix', async () => {
    const { token } = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'web', origins: ['https://a.example.org'], now: NOW });
    const swapped = `plat_ingest_${token.slice('plat_ingest_web_'.length)}`;
    expect((await verifyIngestToken(swapped, NOW)).ok).toBe(false);
  });

  it('rejects tokens signed with another key, accepts the previous key during rotation', async () => {
    const { token } = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'server', now: NOW });
    setIngestSigningKeyForTests('n'.repeat(64));
    expect(await verifyIngestToken(token, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    setIngestSigningKeyForTests('n'.repeat(64), KEY);
    expect((await verifyIngestToken(token, NOW)).ok).toBe(true);
  });

  it('rejects malformed input and non-ingest tokens', async () => {
    for (const t of ['', 'sdk_live_abc', 'plat_agent_x', 'plat_ingest_', 'plat_ingest_abc', 'plat_ingest_a.b.c', `plat_ingest_${'x'.repeat(5000)}`]) {
      expect((await verifyIngestToken(t, NOW)).ok).toBe(false);
    }
  });

  it('refuses to issue for invalid project ids or environment names', async () => {
    await expect(issueIngestToken({ projectId: 'a b', environment: 'dev', type: 'server' })).rejects.toThrow();
    await expect(issueIngestToken({ projectId: PID, environment: '../x', type: 'server' })).rejects.toThrow();
  });
});

describe('origins and scopes', () => {
  it('normalises origins', () => {
    expect(normalizeOrigin('HTTPS://App.Example.org:8443/')).toBe('https://app.example.org:8443');
    expect(normalizeOrigin('app.example.org')).toBe('https://app.example.org');
    expect(normalizeOrigin('https://app.example.org/path')).toBeNull();
    expect(normalizeOrigin('ftp://x.example.org')).toBeNull();
  });

  it('matches exact origins and *.subdomain wildcards, never the bare wildcard parent', () => {
    const allowed = ['https://app.example.org', 'https://*.cdn.example.org'];
    expect(originAllowed('https://app.example.org', allowed)).toBe(true);
    expect(originAllowed('https://a.b.cdn.example.org', allowed)).toBe(true);
    expect(originAllowed('https://cdn.example.org', allowed)).toBe(false);
    expect(originAllowed('http://app.example.org', allowed)).toBe(false);
    expect(originAllowed('https://evilcdn.example.org', allowed)).toBe(false);
    expect(originAllowed('https://app.example.org.evil.test', allowed)).toBe(false);
    expect(originAllowed(undefined, allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
  });

  it('maps collector paths to scopes and token types', () => {
    expect(scopeForPath('/v1/traces')).toBe('otlp');
    expect(scopeForPath('/v1/logs?x=1')).toBe('otlp');
    expect(scopeForPath('/pyroscope/ingest')).toBe('profiles');
    expect(scopeForPath('/collect')).toBe('rum');
    expect(scopeForPath('/admin')).toBeNull();
    expect(tokenTypeAllowedFor('server', 'otlp')).toBe(true);
    expect(tokenTypeAllowedFor('server', 'rum')).toBe(false);
    expect(tokenTypeAllowedFor('web', 'rum')).toBe(true);
    expect(tokenTypeAllowedFor('web', 'otlp')).toBe(false);
    expect(tokenTypeAllowedFor('web', 'profiles')).toBe(false);
  });
});

describe('signing key storage', () => {
  function memoryStore(initial: Record<string, string> = {}): ConfigStore & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      description: 'memory store',
      read: async () => ({ ...data }),
      patch: async (v) => { Object.assign(data, v); },
      createIfAbsent: async (v) => ({ ...data, ...v }),
      setIfAbsent: async (k, v) => { if (!data[k]) data[k] = v; return data[k]; },
    };
  }

  it('generates the key once in the store and reuses an existing one', async () => {
    const store = memoryStore();
    setIngestKeyStoreForTests(store);
    expect(await initIngestSigningKey()).toEqual({ ok: true, source: 'generated in memory store' });
    const generated = store.data[INGEST_SIGNING_KEY_NAME];
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
    const { token } = await issueIngestToken({ projectId: PID, environment: 'dev', type: 'server' });

    // A second replica (fresh process state) reads the same key and accepts the token.
    setIngestKeyStoreForTests(store);
    expect(await initIngestSigningKey()).toEqual({ ok: true, source: 'memory store' });
    expect(store.data[INGEST_SIGNING_KEY_NAME]).toBe(generated);
    expect((await verifyIngestToken(token)).ok).toBe(true);
  });

  it('prefers TELEMETRY_INGEST_SIGNING_KEY from the environment', async () => {
    const store = memoryStore();
    setIngestKeyStoreForTests(store);
    process.env[INGEST_SIGNING_KEY_NAME] = 'e'.repeat(40);
    expect(await initIngestSigningKey()).toEqual({ ok: true, source: 'env' });
    expect(store.data[INGEST_SIGNING_KEY_NAME]).toBeUndefined();
  });

  it('reports failure without throwing and refuses to issue while the store is down', async () => {
    const store = memoryStore();
    store.setIfAbsent = async () => { throw new Error('forbidden'); };
    setIngestKeyStoreForTests(store);
    const r = await initIngestSigningKey();
    expect(r.ok).toBe(false);
    await expect(issueIngestToken({ projectId: PID, environment: 'dev', type: 'server' })).rejects.toThrow(/unavailable/);
  });
});
