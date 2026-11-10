/**
 * #35: GitHub App Manifest flow — manifest generation, single-use state bound to the admin,
 * conversion storage (secrets encrypted, never in the public view), App JWT, installation
 * token caching, webhook signatures and installation webhooks. All HTTP is mocked.
 */
import * as crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { MemoryRepo } from '../../helpers/memory-repo';

class Repo<T extends Record<string, any>> extends MemoryRepo<T> {
  async clear() { this.rows = []; }
}

const repos: Record<string, Repo<any>> = {};
function repoFor(name: string) {
  if (!repos[name]) repos[name] = new Repo<any>();
  return repos[name];
}

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: (entity: any) => repoFor(entity.name) })),
}));

import {
  buildGithubManifest,
  clearInstallationTokenCache,
  clearManifestStatesForTests,
  completeManifestFlow,
  getInstallationToken,
  githubAuthorizationFor,
  githubWebhookSecrets,
  handleInstallationWebhook,
  findInstallationForRepo,
  loadGithubApp,
  signAppJwt,
  startManifestFlow,
  verifyHubSignature,
  verifyManifestState,
  MANIFEST_STATE_TTL_MS,
  TOKEN_REFRESH_MARGIN_MS,
  authenticatedCloneUrl,
} from '../../../src/lib/github-app';
import { publicAppView, loadProviderApp } from '../../../src/lib/git-app-store';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const API = 'https://platform.example.test';
const PORTAL = 'https://platform.example.test';
const ADMIN = 'admin-1';

const CONVERSION = {
  id: 424242,
  slug: 'platform-example',
  name: 'Platform example',
  html_url: 'https://github.com/apps/platform-example',
  owner: { login: 'acme', type: 'Organization' },
  client_id: 'Iv1.testclientid',
  client_secret: 'test-client-secret-value-0123456789',
  webhook_secret: 'test-webhook-secret-value-0123456789',
  pem: privateKey,
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const originalFetch = global.fetch;

beforeEach(() => {
  for (const k of Object.keys(repos)) delete repos[k];
  clearManifestStatesForTests();
  process.env.JWT_SECRET = 'github-app-unit-test-secret-0123456789';
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  return clearInstallationTokenCache();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

async function connectApp() {
  const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
  global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(201, CONVERSION)) as any;
  return completeManifestFlow({ code: 'abc123', state, userId: ADMIN });
}

describe('manifest generation', () => {
  it('requests the minimum permissions and the deploy events with this install\'s URLs', () => {
    const m = buildGithubManifest({ apiBase: `${API}/`, portalBase: PORTAL });
    expect(m.default_permissions).toEqual({ contents: 'read', metadata: 'read', pull_requests: 'read', emails: 'read' });
    expect(m.default_events).toEqual(['push', 'pull_request']);
    expect(m.hook_attributes).toEqual({ url: `${API}/api/webhooks/github`, active: true });
    expect(m.callback_urls).toEqual([`${API}/api/auth/github/callback`]);
    expect(m.redirect_url).toBe(`${PORTAL}/settings`);
    expect(m.setup_url).toBe(`${PORTAL}/settings`);
    expect(m.public).toBe(false);
    expect(m.name.length).toBeLessThanOrEqual(34);
  });

  it('caps a custom name at GitHub\'s 34 characters', () => {
    expect(buildGithubManifest({ apiBase: API, portalBase: PORTAL, name: 'x'.repeat(50) }).name).toHaveLength(34);
  });

  it('posts to the personal or organization creation page with the state', async () => {
    const user = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    expect(user.postUrl).toBe(`https://github.com/settings/apps/new?state=${user.state}`);
    const org = await startManifestFlow({ userId: ADMIN, ownerType: 'org', org: 'acme-inc', apiBase: API, portalBase: PORTAL });
    expect(org.postUrl).toBe(`https://github.com/organizations/acme-inc/settings/apps/new?state=${org.state}`);
    expect(org.state).not.toBe(user.state);
  });

  it('rejects an invalid organization login', async () => {
    await expect(startManifestFlow({ userId: ADMIN, ownerType: 'org', org: '../evil', apiBase: API, portalBase: PORTAL }))
      .rejects.toThrow(/organization/);
  });
});

describe('manifest state', () => {
  it('is single use (replay is rejected)', async () => {
    const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    await expect(verifyManifestState(state, ADMIN)).resolves.toMatchObject({ userId: ADMIN });
    await expect(verifyManifestState(state, ADMIN)).rejects.toThrow(/already used/);
  });

  it('is bound to the admin who started the flow and burned on a mismatch', async () => {
    const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    await expect(verifyManifestState(state, 'someone-else')).rejects.toMatchObject({ status: 403 });
    await expect(verifyManifestState(state, ADMIN)).rejects.toThrow(/already used/);
  });

  it('expires', async () => {
    const t0 = Date.now();
    const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    jest.spyOn(Date, 'now').mockReturnValue(t0 + MANIFEST_STATE_TTL_MS + 1000);
    await expect(verifyManifestState(state, ADMIN)).rejects.toThrow(/expired/);
  });

  it('rejects unknown or malformed states', async () => {
    await expect(verifyManifestState('nope', ADMIN)).rejects.toThrow();
    await expect(verifyManifestState(undefined, ADMIN)).rejects.toThrow();
  });

  it('does not call GitHub when the state is invalid', async () => {
    global.fetch = jest.fn() as any;
    await expect(completeManifestFlow({ code: 'abc', state: 'forged', userId: ADMIN })).rejects.toThrow();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('conversion', () => {
  it('exchanges the code and stores every secret encrypted', async () => {
    const { row, installUrl } = await connectApp();
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.github.com/app-manifests/abc123/conversions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(installUrl).toBe('https://github.com/apps/platform-example/installations/new');

    const stored = await loadProviderApp('github');
    expect(stored).toMatchObject({ appId: '424242', slug: 'platform-example', owner: 'acme', ownerType: 'Organization', clientId: 'Iv1.testclientid', createdBy: ADMIN });
    const raw = JSON.stringify(repos.GitProviderApp.rows);
    expect(raw).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(raw).not.toContain(CONVERSION.client_secret);
    expect(raw).not.toContain(CONVERSION.webhook_secret);

    const creds = await loadGithubApp();
    expect(creds).toEqual({
      appId: '424242', slug: 'platform-example', clientId: 'Iv1.testclientid',
      clientSecret: CONVERSION.client_secret, webhookSecret: CONVERSION.webhook_secret, privateKey,
    });
    expect(row.id).toBeTruthy();
  });

  it('never exposes secrets in the public view', async () => {
    const { row } = await connectApp();
    const view = JSON.stringify(publicAppView(row));
    expect(view).not.toContain(CONVERSION.client_secret);
    expect(view).not.toContain(CONVERSION.webhook_secret);
    expect(view).not.toContain('PRIVATE KEY');
    expect(view).not.toMatch(/"[0-9a-f]{32}:[0-9a-f]{32}:/); // no ciphertext either
    expect(publicAppView(row)).toMatchObject({ connected: true, hasPrivateKey: true, hasClientSecret: true, hasWebhookSecret: true });
  });

  it('reports GitHub errors without storing anything', async () => {
    const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(404, { message: 'Not Found' })) as any;
    await expect(completeManifestFlow({ code: 'expired', state, userId: ADMIN })).rejects.toMatchObject({ status: 502 });
    expect(await loadProviderApp('github')).toBeNull();
  });

  it('rejects an incomplete conversion', async () => {
    const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(201, { ...CONVERSION, pem: 'not a key' })) as any;
    await expect(completeManifestFlow({ code: 'abc', state, userId: ADMIN })).rejects.toThrow(/incomplete/);
  });

  it('reconnect replaces the previous App', async () => {
    await connectApp();
    const { state } = await startManifestFlow({ userId: ADMIN, apiBase: API, portalBase: PORTAL });
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(201, { ...CONVERSION, id: 99, slug: 'second' })) as any;
    await completeManifestFlow({ code: 'def', state, userId: ADMIN });
    expect(repos.GitProviderApp.rows).toHaveLength(1);
    expect((await loadGithubApp())?.appId).toBe('99');
  });
});

describe('App JWT and installation tokens', () => {
  it('signs an RS256 JWT for the App id that GitHub accepts (<= 10 min)', () => {
    const now = 1_800_000_000;
    const token = signAppJwt('424242', privateKey, now);
    const decoded: any = jwt.verify(token, publicKey, { algorithms: ['RS256'], clockTimestamp: now });
    expect(decoded.iss).toBe('424242');
    expect(decoded.iat).toBe(now - 60);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(600);
    expect((jwt.decode(token, { complete: true }) as any).header.alg).toBe('RS256');
  });

  it('mints an installation token once and caches it until shortly before expiry', async () => {
    await connectApp();
    const t0 = Date.now();
    const expiresAt = new Date(t0 + 60 * 60 * 1000).toISOString();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(201, { token: 'ghs_first', expires_at: expiresAt }))
      .mockResolvedValueOnce(jsonResponse(201, { token: 'ghs_second', expires_at: new Date(t0 + 2 * 60 * 60 * 1000).toISOString() })) as any;

    expect(await getInstallationToken('777')).toBe('ghs_first');
    expect(await getInstallationToken('777')).toBe('ghs_first');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.github.com/app/installations/777/access_tokens');
    const bearer = String(init.headers.Authorization).replace(/^Bearer /, '');
    expect((jwt.verify(bearer, publicKey, { algorithms: ['RS256'] }) as any).iss).toBe('424242');

    // Inside the refresh margin: a new token is minted.
    jest.spyOn(Date, 'now').mockReturnValue(t0 + 60 * 60 * 1000 - TOKEN_REFRESH_MARGIN_MS + 1000);
    expect(await getInstallationToken('777')).toBe('ghs_second');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a malformed installation id and needs a connected App', async () => {
    await expect(getInstallationToken('1')).rejects.toThrow(/not connected/);
    await connectApp();
    await expect(getInstallationToken('1/../x')).rejects.toThrow(/Invalid installation id/);
  });
});

describe('webhook signatures', () => {
  const body = Buffer.from('{"zen":"ok"}');
  const sign = (secret: string) => 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the App webhook secret and the legacy env secret', async () => {
    await connectApp();
    process.env.GITHUB_WEBHOOK_SECRET = 'legacy-env-secret';
    const secrets = await githubWebhookSecrets();
    expect(verifyHubSignature(body, sign(CONVERSION.webhook_secret), secrets)).toBe(true);
    expect(verifyHubSignature(body, sign('legacy-env-secret'), secrets)).toBe(true);
  });

  it('rejects wrong, malformed or missing signatures and non-raw bodies', async () => {
    await connectApp();
    const secrets = await githubWebhookSecrets();
    expect(verifyHubSignature(body, sign('wrong'), secrets)).toBe(false);
    expect(verifyHubSignature(body, 'sha256=xyz', secrets)).toBe(false);
    expect(verifyHubSignature(body, undefined, secrets)).toBe(false);
    expect(verifyHubSignature({ zen: 'ok' }, sign(CONVERSION.webhook_secret), secrets)).toBe(false);
    expect(verifyHubSignature(body, sign(''), [])).toBe(false);
  });
});

describe('installation webhooks and repository mapping', () => {
  const installation = (extra: any = {}) => ({
    id: 777, app_id: 424242, account: { login: 'Acme', type: 'Organization' }, repository_selection: 'selected', ...extra,
  });

  it('records installations, repository changes and removal', async () => {
    await connectApp();
    await handleInstallationWebhook('installation', {
      action: 'created', installation: installation(), repositories: [{ full_name: 'Acme/web' }, { full_name: 'acme/api' }],
    });
    expect(await findInstallationForRepo('acme', 'web')).toMatchObject({ installationId: '777' });
    expect(await findInstallationForRepo('acme', 'other')).toBeNull();

    await handleInstallationWebhook('installation_repositories', {
      action: 'added', installation: installation(), repositories_added: [{ full_name: 'acme/other' }], repositories_removed: [{ full_name: 'acme/web' }],
    });
    expect(await findInstallationForRepo('acme', 'other')).not.toBeNull();
    expect(await findInstallationForRepo('acme', 'web')).toBeNull();

    await handleInstallationWebhook('installation', { action: 'suspend', installation: installation() });
    expect(await findInstallationForRepo('acme', 'other')).toBeNull();

    await handleInstallationWebhook('installation', { action: 'deleted', installation: installation() });
    expect(repos.GitAppInstallation.rows).toHaveLength(0);
  });

  it('covers every repository of the account in "all" mode', async () => {
    await connectApp();
    await handleInstallationWebhook('installation', { action: 'created', installation: installation({ repository_selection: 'all' }) });
    expect(await findInstallationForRepo('ACME', 'anything')).not.toBeNull();
    expect(await findInstallationForRepo('other-org', 'anything')).toBeNull();
  });

  it('ignores installations of another App', async () => {
    await connectApp();
    const r = await handleInstallationWebhook('installation', { action: 'created', installation: installation({ app_id: 1 }) });
    expect(r.handled).toBe(false);
    expect(repos.GitAppInstallation?.rows || []).toHaveLength(0);
  });

  it('uses an installation token for covered repos and falls back to GITHUB_TOKEN otherwise', async () => {
    await connectApp();
    await handleInstallationWebhook('installation', { action: 'created', installation: installation(), repositories: [{ full_name: 'acme/web' }] });
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(201, { token: 'ghs_inst', expires_at: new Date(Date.now() + 3600_000).toISOString() })) as any;
    expect(await githubAuthorizationFor('acme', 'web')).toBe('Bearer ghs_inst');
    expect(await authenticatedCloneUrl('acme', 'web')).toBe('https://x-access-token:ghs_inst@github.com/acme/web.git');
    expect(await githubAuthorizationFor('acme', 'private-elsewhere')).toBeNull();
    process.env.GITHUB_TOKEN = 'legacy-token';
    expect(await githubAuthorizationFor('acme', 'private-elsewhere')).toBe('Bearer legacy-token');
  });
});
