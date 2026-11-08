/**
 * GitHub/GitLab portal login: browser-bound state cookie, one-time exchange code (no JWT in URLs),
 * verified-email linking, least-privilege sign-up and the optional domain/org allowlists.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class { loadFromDefault() {} makeApiClient() { return {}; } },
  CustomObjectsApi: class {},
}));
jest.mock('../../src/lib/k8s', () => ({
  checkK8sConnection: jest.fn().mockResolvedValue(true),
  getK8sNodes: jest.fn().mockResolvedValue([]),
  getK8sNamespaces: jest.fn().mockResolvedValue([]),
  getK8sPods: jest.fn().mockResolvedValue([]),
  getPodLogs: jest.fn().mockResolvedValue(''),
  deletePod: jest.fn().mockResolvedValue(true),
  updateArgoCDApp: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../src/lib/lokilog', () => ({ forwardToLoki: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/config/mongoose', () => ({ connectMongo: jest.fn().mockResolvedValue(true) }));
jest.mock('../../src/lib/notify', () => ({
  notifyUser: jest.fn().mockResolvedValue(undefined),
  notifyRoles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/lib/integrations', () => {
  const actual = jest.requireActual('../../src/lib/integrations');
  return {
    ...actual,
    resolveIntegrations: jest.fn().mockResolvedValue({
      row: null,
      githubClientId: 'gh-client',
      githubClientSecret: 'gh-secret',
      gitlabUrl: 'https://gitlab.example.test',
      gitlabClientId: 'gl-client',
      gitlabClientSecret: 'gl-secret',
      githubLoginEnabled: true,
      gitlabLoginEnabled: true,
    }),
  };
});

const users = new Map<string, any>();
const mockUserRepo = {
  findOne: jest.fn(({ where }: any) => {
    for (const u of users.values()) {
      if (Object.keys(where).every((k) => u[k] === where[k])) return Promise.resolve({ ...u });
    }
    return Promise.resolve(null);
  }),
  create: jest.fn((d: any) => ({ ...d })),
  save: jest.fn((u: any) => {
    users.set(u.id, { ...u });
    return Promise.resolve(u);
  }),
};
jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue({
    getRepository: jest.fn((entity: any) => {
      const name = typeof entity === 'string' ? entity : entity?.name;
      if (name === 'User') return mockUserRepo;
      return { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]), save: jest.fn(), create: jest.fn((d: any) => d) };
    }),
  }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import apiRouter from '../../src/routes/api';

const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';

interface GhFixture {
  id: number;
  login: string;
  profileEmail?: string | null;
  emails: Array<{ email: string; primary: boolean; verified: boolean }>;
  orgs?: string[];
}

let gh: GhFixture;
const fetchMock = jest.fn(async (url: string) => {
  const json = (body: unknown) => ({ json: async () => body }) as any;
  if (url.startsWith('https://github.com/login/oauth/access_token')) return json({ access_token: 'gh-access' });
  if (url === 'https://api.github.com/user') return json({ id: gh.id, login: gh.login, name: gh.login, email: gh.profileEmail ?? null });
  if (url === 'https://api.github.com/user/emails') return json(gh.emails);
  if (url.startsWith('https://api.github.com/user/orgs')) return json((gh.orgs || []).map((login) => ({ login })));
  throw new Error(`unexpected fetch ${url}`);
});

let app: express.Express;

beforeAll(() => {
  process.env.DOMAIN = 'platform.example.test';
  (global as any).fetch = fetchMock;
  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
});

beforeEach(() => {
  users.clear();
  jest.clearAllMocks();
  delete process.env.OAUTH_ALLOWED_DOMAINS;
  delete process.env.OAUTH_ALLOWED_ORGS;
  gh = { id: 4242, login: 'octo', emails: [{ email: 'octo@example.test', primary: true, verified: true }] };
});

function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] || []);
  const c = raw.find((h) => h.startsWith(`${name}=`));
  return c ? c.split(';')[0].slice(name.length + 1) : undefined;
}

async function startGithub() {
  const res = await request(app).get('/api/auth/github');
  expect(res.status).toBe(302);
  const state = new URL(res.headers.location).searchParams.get('state')!;
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] || []).join('\n');
  return { state, cookie: cookieValue(res, 'plat_oauth_state'), setCookie };
}

async function callback(state: string, cookie?: string) {
  const req = request(app).get('/api/auth/github/callback').query({ code: 'gh-code', state });
  if (cookie !== undefined) req.set('Cookie', `plat_oauth_state=${cookie}`);
  return req;
}

describe('GitHub login state binding (M5)', () => {
  it('sets an httpOnly SameSite=Lax state cookie with a TTL', async () => {
    const { state, cookie, setCookie } = await startGithub();
    expect(cookie).toBe(state);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Max-Age=\d+/);
  });

  it('rejects a callback whose state is not bound to this browser (login CSRF)', async () => {
    const { state } = await startGithub();
    const noCookie = await callback(state);
    expect(noCookie.headers.location).toMatch(/\/login\?error=/);
    const { state: other } = await startGithub();
    const wrongCookie = await callback(state, other);
    expect(wrongCookie.headers.location).toMatch(/\/login\?error=/);
    expect(users.size).toBe(0);
  });

  it('accepts a state only once', async () => {
    const { state, cookie } = await startGithub();
    const first = await callback(state, cookie);
    expect(first.headers.location).toMatch(/\/dashboard\?code=/);
    const replay = await callback(state, cookie);
    expect(replay.headers.location).toMatch(/\/login\?error=/);
  });
});

describe('no session JWT in URLs (H13 / P-02)', () => {
  it('redirects with a one-time code that POST /api/auth/exchange swaps for a session', async () => {
    const { state, cookie } = await startGithub();
    const cb = await callback(state, cookie);
    const location = new URL(cb.headers.location);
    expect(location.origin).toBe('https://platform.example.test');
    expect(location.pathname).toBe('/dashboard');
    expect(location.searchParams.get('token')).toBeNull();
    const code = location.searchParams.get('code')!;
    expect(code).toBeTruthy();
    expect(code.split('.').length).not.toBe(3); // not a JWT

    const ex = await request(app).post('/api/auth/exchange').send({ code });
    expect(ex.status).toBe(200);
    expect(ex.headers['cache-control']).toBe('no-store');
    const decoded: any = jwt.verify(ex.body.token, JWT_SECRET);
    expect(decoded.email).toBe('octo@example.test');
    expect(ex.body.user.passwordHash).toBeUndefined();

    const reuse = await request(app).post('/api/auth/exchange').send({ code });
    expect(reuse.status).toBe(400);
  });

  it('rejects unknown exchange codes', async () => {
    const r = await request(app).post('/api/auth/exchange').send({ code: 'nope' });
    expect(r.status).toBe(400);
  });

  it('ignores a spoofed Host when building the portal redirect', async () => {
    const { state, cookie } = await startGithub();
    const cb = await request(app)
      .get('/api/auth/github/callback')
      .set('Host', 'evil.example')
      .set('Cookie', `plat_oauth_state=${cookie}`)
      .query({ code: 'gh-code', state });
    expect(cb.headers.location.startsWith('https://platform.example.test/dashboard?code=')).toBe(true);
  });
});

describe('account linking and sign-up (M5)', () => {
  it('creates new OAuth users as viewer', async () => {
    const { state, cookie } = await startGithub();
    await callback(state, cookie);
    const created = [...users.values()][0];
    expect(created.role).toBe('viewer');
    expect(created.email).toBe('octo@example.test');
  });

  it('does not link an existing account through an unverified email', async () => {
    users.set('admin-1', { id: 'admin-1', email: 'admin@example.test', role: 'admin', isActive: true, githubId: null });
    gh.profileEmail = 'admin@example.test';
    gh.emails = [
      { email: 'admin@example.test', primary: false, verified: false },
      { email: 'octo@example.test', primary: true, verified: true },
    ];
    const { state, cookie } = await startGithub();
    const cb = await callback(state, cookie);
    const ex = await request(app).post('/api/auth/exchange').send({ code: new URL(cb.headers.location).searchParams.get('code') });
    expect(ex.body.user.id).not.toBe('admin-1');
    expect(users.get('admin-1').githubId).toBeNull();
  });

  it('refuses sign-up when the provider reports no verified primary email', async () => {
    gh.emails = [{ email: 'octo@example.test', primary: true, verified: false }];
    const { state, cookie } = await startGithub();
    const cb = await callback(state, cookie);
    expect(cb.headers.location).toMatch(/\/login\?error=/);
    expect(users.size).toBe(0);
  });

  it('links an existing account by verified email', async () => {
    users.set('dev-1', { id: 'dev-1', email: 'octo@example.test', role: 'developer', isActive: true, githubId: null });
    const { state, cookie } = await startGithub();
    await callback(state, cookie);
    expect(users.get('dev-1').githubId).toBe('4242');
    expect(users.size).toBe(1);
  });

  it('does not issue a session for an inactive account', async () => {
    users.set('dev-1', { id: 'dev-1', email: 'octo@example.test', role: 'developer', isActive: false, githubId: '4242' });
    const { state, cookie } = await startGithub();
    const cb = await callback(state, cookie);
    expect(cb.headers.location).toMatch(/\/login\?error=/);
  });
});

describe('OAUTH_ALLOWED_DOMAINS / OAUTH_ALLOWED_ORGS', () => {
  it('blocks emails outside the allowed domains', async () => {
    process.env.OAUTH_ALLOWED_DOMAINS = 'corp.example';
    const { state, cookie } = await startGithub();
    const cb = await callback(state, cookie);
    expect(cb.headers.location).toMatch(/\/login\?error=/);
    expect(users.size).toBe(0);
  });

  it('allows emails in an allowed domain', async () => {
    process.env.OAUTH_ALLOWED_DOMAINS = 'corp.example, example.test';
    const { state, cookie } = await startGithub();
    const cb = await callback(state, cookie);
    expect(cb.headers.location).toMatch(/\/dashboard\?code=/);
  });

  it('requires membership in an allowed org and requests read:org', async () => {
    process.env.OAUTH_ALLOWED_ORGS = 'acme';
    const start = await request(app).get('/api/auth/github');
    expect(new URL(start.headers.location).searchParams.get('scope')).toContain('read:org');

    gh.orgs = ['other'];
    let s = await startGithub();
    expect((await callback(s.state, s.cookie)).headers.location).toMatch(/\/login\?error=/);

    gh.orgs = ['ACME'];
    s = await startGithub();
    expect((await callback(s.state, s.cookie)).headers.location).toMatch(/\/dashboard\?code=/);
  });
});
