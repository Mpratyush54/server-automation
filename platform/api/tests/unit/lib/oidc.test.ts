import * as crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getOidcIssuer } from '../../../src/lib/oidc-issuer';
import { getOidcClients, findOidcClient, isRegisteredRedirectUri, verifyClientSecret, resetOidcClientCache } from '../../../src/lib/oidc-clients';
import { loadOidcSigningKey } from '../../../src/lib/oidc-keys';
import { OneTimeCodeStore, verifyPkceS256 } from '../../../src/lib/oidc-codes';

const ENV_KEYS = ['DOMAIN', 'OIDC_ISSUER', 'OIDC_CLIENTS', 'OIDC_SIGNING_KEY', 'OIDC_SIGNING_KEY_FILE', 'OIDC_CLIENT_SECRET_GRAFANA', 'OIDC_CLIENT_SECRET_ARGOCD', 'OIDC_ALLOW_LEGACY_SECRETS'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetOidcClientCache();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  jest.restoreAllMocks();
});

describe('oidc issuer', () => {
  it('defaults to https://DOMAIN/api/oauth', () => {
    process.env.DOMAIN = 'p.example.test';
    expect(getOidcIssuer()).toBe('https://p.example.test/api/oauth');
  });

  it('prefers OIDC_ISSUER', () => {
    process.env.DOMAIN = 'p.example.test';
    process.env.OIDC_ISSUER = 'https://id.example.test/api/oauth/';
    expect(getOidcIssuer()).toBe('https://id.example.test/api/oauth');
  });
});

describe('oidc client registry', () => {
  it('derives exact redirect URIs from DOMAIN for the installed apps (no infisical)', () => {
    process.env.DOMAIN = 'p.example.test';
    process.env.OIDC_ALLOW_LEGACY_SECRETS = 'true';
    const byId = Object.fromEntries(getOidcClients().map((c) => [c.id, c.redirectUris]));
    expect(byId).toEqual({
      grafana: ['https://p.example.test/grafana/login/generic_oauth'],
      argocd: ['https://p.example.test/argocd/auth/callback'],
      portainer: ['https://portainer.p.example.test/'],
      'oauth2-proxy': ['https://p.example.test/oauth2/callback'],
      minio: ['https://minio.p.example.test/oauth_callback'],
    });
    expect(findOidcClient('infisical')).toBeNull();
  });

  it('never registers a built-in client with a public placeholder secret by default', () => {
    process.env.DOMAIN = 'p.example.test';
    process.env.OIDC_CLIENT_SECRET_ARGOCD = 'unique-argocd-secret';
    expect(getOidcClients().map((c) => c.id)).toEqual(['argocd']);
    expect(findOidcClient('grafana')).toBeNull();
  });

  it('registers nothing without DOMAIN or OIDC_CLIENTS', () => {
    expect(getOidcClients()).toEqual([]);
  });

  it('treats OIDC_CLIENTS as authoritative', () => {
    process.env.DOMAIN = 'p.example.test';
    process.env.OIDC_CLIENTS = JSON.stringify([{ id: 'grafana', secret: 'generated-secret-1', redirectUris: ['https://p.example.test/grafana/login/generic_oauth'] }]);
    expect(getOidcClients().map((c) => c.id)).toEqual(['grafana']);
    const g = findOidcClient('grafana')!;
    expect(verifyClientSecret(g, 'generated-secret-1')).toBe(true);
    expect(verifyClientSecret(g, 'grafana-secret-placeholder')).toBe(false);
    expect(findOidcClient('argocd')).toBeNull();
  });

  it('rejects malformed OIDC_CLIENTS', () => {
    process.env.OIDC_CLIENTS = JSON.stringify([{ id: 'x', secret: 'short', redirectUris: ['https://a/cb'] }]);
    expect(() => getOidcClients()).toThrow(/secret/);
  });

  it('matches redirect URIs exactly (no prefix / host tricks)', () => {
    process.env.DOMAIN = 'p.example.test';
    process.env.OIDC_CLIENT_SECRET_ARGOCD = 'unique-argocd-secret';
    const argo = findOidcClient('argocd')!;
    expect(isRegisteredRedirectUri(argo, 'https://p.example.test/argocd/auth/callback')).toBe(true);
    for (const bad of [
      'https://p.example.test/argocd/auth/callback/../../evil',
      'https://p.example.test/argocd/auth/callback?x=1',
      'https://p.example.test.evil.net/argocd/auth/callback',
      'http://p.example.test/argocd/auth/callback',
    ]) {
      expect(isRegisteredRedirectUri(argo, bad)).toBe(false);
    }
  });
});

describe('oidc signing key', () => {
  it('loads OIDC_SIGNING_KEY with a stable kid', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    process.env.OIDC_SIGNING_KEY = privateKey.replace(/\n/g, '\\n');
    const a = loadOidcSigningKey();
    const b = loadOidcSigningKey();
    expect(a.source).toBe('env');
    expect(a.kid).toBe(b.kid);
  });

  it('persists a generated key to the key file and reuses it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-key-'));
    process.env.OIDC_SIGNING_KEY_FILE = path.join(dir, 'k.pem');
    const first = loadOidcSigningKey();
    expect(first.source).toBe('generated-file');
    const second = loadOidcSigningKey();
    expect(second.source).toBe('file');
    expect(second.kid).toBe(first.kid);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('one-time codes + PKCE', () => {
  it('codes are single use and expire', () => {
    jest.useFakeTimers();
    try {
      const store = new OneTimeCodeStore<number>(1000);
      const c = store.issue(1);
      expect(store.consume(c)).toBe(1);
      expect(store.consume(c)).toBeNull();
      const d = store.issue(2);
      jest.advanceTimersByTime(1500);
      expect(store.consume(d)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('verifies S256', () => {
    const verifier = 'a'.repeat(43);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
    expect(verifyPkceS256('b'.repeat(43), challenge)).toBe(false);
  });
});
