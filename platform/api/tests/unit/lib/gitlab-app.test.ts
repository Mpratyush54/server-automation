/**
 * #35: GitLab OAuth application automation — instance-admin and group paths, manual fallback,
 * encrypted storage, bootstrap-token handling and webhook secrets. All HTTP is mocked.
 */
import { MemoryRepo } from '../../helpers/memory-repo';

const repos: Record<string, MemoryRepo<any>> = {};
function repoFor(name: string) {
  if (!repos[name]) repos[name] = new MemoryRepo<any>();
  return repos[name];
}

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(async () => ({ getRepository: (entity: any) => repoFor(entity.name) })),
}));

import {
  connectGitlab, gitlabApiToken, gitlabWebhookCredentials, gitlabWebhookSecrets, loadGitlabApp,
  normalizeGitlabBaseUrl, verifyGitlabTokenAgainst, GITLAB_OAUTH_SCOPES,
} from '../../../src/lib/gitlab-app';
import { publicAppView, loadProviderApp } from '../../../src/lib/git-app-store';

const BASE = 'https://gitlab.example.test';
const REDIRECT = 'https://platform.example.test/api/auth/gitlab/callback';
// Built at runtime so secret scanners do not flag the fake fixture.
const TOKEN = ['glpat', 'test-bootstrap-token'].join('-');

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Route mocked GitLab endpoints by method + path. */
function mockGitlab(routes: Record<string, () => any>) {
  global.fetch = jest.fn(async (url: string, init: any = {}) => {
    const path = new URL(url).pathname;
    const key = `${init.method || 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) return jsonResponse(404, { message: '404 Not Found' });
    return handler();
  }) as any;
}

const APP = { id: 12, application_id: 'gl-client-id', application_name: 'Platform login', secret: 'gloas-test-secret', callback_url: REDIRECT, confidential: true };
const originalFetch = global.fetch;

beforeEach(() => {
  for (const k of Object.keys(repos)) delete repos[k];
  process.env.JWT_SECRET = 'gitlab-app-unit-test-secret-0123456789';
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITLAB_WEBHOOK_SECRET;
  delete process.env.GITLAB_WEBHOOK_TOKEN;
});
afterEach(() => { global.fetch = originalFetch; });

describe('base URL', () => {
  it('accepts gitlab.com and self-managed (with a relative path) over HTTPS', () => {
    expect(normalizeGitlabBaseUrl(undefined)).toBe('https://gitlab.com');
    expect(normalizeGitlabBaseUrl('https://git.example.test/gitlab/')).toBe('https://git.example.test/gitlab');
  });
  it.each(['http://gitlab.example.test', 'https://user:pw@gitlab.example.test', 'https://gitlab.example.test/?x=1', 'not a url'])('rejects %s', (u) => {
    expect(() => normalizeGitlabBaseUrl(u)).toThrow();
  });
});

describe('connectGitlab', () => {
  it('creates an instance application with an admin token and discards the token by default', async () => {
    mockGitlab({
      'GET /api/v4/user': () => jsonResponse(200, { id: 1, username: 'root', is_admin: true }),
      'GET /api/v4/personal_access_tokens/self': () => jsonResponse(200, { scopes: ['api'] }),
      'POST /api/v4/applications': () => jsonResponse(201, APP),
    });
    const out = await connectGitlab({ baseUrl: BASE, token: TOKEN, redirectUri: REDIRECT, userId: 'admin-1' });
    expect(out).toMatchObject({ mode: 'instance', tokenKept: false });

    const post = (global.fetch as jest.Mock).mock.calls.find(([, i]) => i?.method === 'POST');
    expect(post[0]).toBe(`${BASE}/api/v4/applications`);
    expect(post[1].headers['PRIVATE-TOKEN']).toBe(TOKEN);
    expect(post[1].redirect).toBe('error');
    expect(JSON.parse(post[1].body)).toEqual({ name: 'Platform login', redirect_uri: REDIRECT, scopes: GITLAB_OAUTH_SCOPES, confidential: true });

    const raw = JSON.stringify(repos.GitProviderApp.rows);
    expect(raw).not.toContain(APP.secret);
    expect(raw).not.toContain(TOKEN);
    const row = await loadProviderApp('gitlab');
    expect(row).toMatchObject({ baseUrl: BASE, clientId: 'gl-client-id', ownerType: 'instance', apiTokenEnc: null });
    const creds = await loadGitlabApp();
    expect(creds?.clientSecret).toBe(APP.secret);
    expect(creds?.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(creds?.apiToken).toBe('');
    expect(JSON.stringify(publicAppView(row))).not.toContain(APP.secret);
  });

  it('keeps the token encrypted when asked, for webhook registration', async () => {
    mockGitlab({
      'GET /api/v4/user': () => jsonResponse(200, { id: 1, is_admin: true }),
      'POST /api/v4/applications': () => jsonResponse(201, APP),
    });
    const out = await connectGitlab({ baseUrl: BASE, token: TOKEN, keepToken: true, redirectUri: REDIRECT, userId: 'admin-1' });
    expect(out.tokenKept).toBe(true);
    expect(JSON.stringify(repos.GitProviderApp.rows)).not.toContain(TOKEN);
    expect(await gitlabApiToken()).toBe(TOKEN);
    const wh = await gitlabWebhookCredentials();
    expect(wh.apiToken).toBe(TOKEN);
    expect(wh.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('asks for a group when the token is not an instance admin', async () => {
    mockGitlab({ 'GET /api/v4/user': () => jsonResponse(200, { id: 2, is_admin: false }) });
    await expect(connectGitlab({ baseUrl: BASE, token: TOKEN, redirectUri: REDIRECT, userId: 'u' }))
      .rejects.toMatchObject({ status: 400, extra: { needsGroup: true } });
    expect(repos.GitProviderApp?.rows || []).toHaveLength(0);
  });

  it('creates a group application when the API supports it', async () => {
    mockGitlab({
      'GET /api/v4/user': () => jsonResponse(200, { id: 2, is_admin: false }),
      'POST /api/v4/groups/team%2Fsub/applications': () => jsonResponse(201, APP),
    });
    const out = await connectGitlab({ baseUrl: BASE, token: TOKEN, groupPath: 'team/sub', redirectUri: REDIRECT, userId: 'u' });
    expect(out.mode).toBe('group');
    expect(await loadProviderApp('gitlab')).toMatchObject({ owner: 'team/sub', ownerType: 'group' });
  });

  it('falls back to manual entry when group applications have no API', async () => {
    mockGitlab({ 'GET /api/v4/user': () => jsonResponse(200, { id: 2, is_admin: false }) });
    await expect(connectGitlab({ baseUrl: BASE, token: TOKEN, groupPath: 'team', redirectUri: REDIRECT, userId: 'u' }))
      .rejects.toMatchObject({ status: 422, extra: { manualRequired: true, redirectUri: REDIRECT } });
  });

  it('rejects a token without the api scope, a rejected token, and bad input', async () => {
    mockGitlab({
      'GET /api/v4/user': () => jsonResponse(200, { id: 1, is_admin: true }),
      'GET /api/v4/personal_access_tokens/self': () => jsonResponse(200, { scopes: ['read_user'] }),
    });
    await expect(connectGitlab({ baseUrl: BASE, token: TOKEN, redirectUri: REDIRECT, userId: 'u' })).rejects.toThrow(/api scope/);

    mockGitlab({ 'GET /api/v4/user': () => jsonResponse(401, { message: '401 Unauthorized' }) });
    await expect(connectGitlab({ baseUrl: BASE, token: TOKEN, redirectUri: REDIRECT, userId: 'u' })).rejects.toThrow(/rejected the token/);

    global.fetch = jest.fn() as any;
    await expect(connectGitlab({ baseUrl: BASE, token: '', redirectUri: REDIRECT, userId: 'u' })).rejects.toThrow(/token/);
    await expect(connectGitlab({ baseUrl: BASE, token: TOKEN, groupPath: '../x y', redirectUri: REDIRECT, userId: 'u' })).rejects.toThrow(/Group path/);
    await expect(connectGitlab({ baseUrl: 'http://gitlab.example.test', token: TOKEN, redirectUri: REDIRECT, userId: 'u' })).rejects.toThrow(/https/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('webhook secrets', () => {
  it('accepts the stored secret and the env secret, constant-time', async () => {
    mockGitlab({
      'GET /api/v4/user': () => jsonResponse(200, { id: 1, is_admin: true }),
      'POST /api/v4/applications': () => jsonResponse(201, APP),
    });
    await connectGitlab({ baseUrl: BASE, token: TOKEN, redirectUri: REDIRECT, userId: 'u' });
    process.env.GITLAB_WEBHOOK_SECRET = 'env-hook-secret';
    const secrets = await gitlabWebhookSecrets();
    const stored = (await loadGitlabApp())!.webhookSecret;
    expect(verifyGitlabTokenAgainst(stored, secrets)).toBe(true);
    expect(verifyGitlabTokenAgainst('env-hook-secret', secrets)).toBe(true);
    expect(verifyGitlabTokenAgainst('wrong', secrets)).toBe(false);
    expect(verifyGitlabTokenAgainst(undefined, secrets)).toBe(false);
    expect(verifyGitlabTokenAgainst('', [''])).toBe(false);
  });
});
