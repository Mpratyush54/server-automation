/**
 * Issue #18: request-spanning auth state lives in Redis, so every leg of a login can be served
 * by a different API replica. Two independent copies of the API router ("pod A" and "pod B",
 * loaded with jest.isolateModules) share one Redis (ioredis-mock) and nothing else.
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

// One "database" shared by both pods (it is external state, like Postgres).
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
import RedisMock from 'ioredis-mock';

const JWT_SECRET = (process.env.JWT_SECRET = process.env.JWT_SECRET || 'multi-replica-test-jwt-secret-0123456789');
process.env.DOMAIN = 'platform.example.test';
process.env.OIDC_CLIENT_SECRET_ARGOCD = 'argocd-test-secret-0123456789';
const ARGO_REDIRECT = 'https://platform.example.test/argocd/auth/callback';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

const fetchMock = jest.fn(async (url: string) => {
  const json = (body: unknown) => ({ json: async () => body }) as any;
  if (url.startsWith('https://github.com/login/oauth/access_token')) return json({ access_token: 'gh-access' });
  if (url === 'https://api.github.com/user') return json({ id: 77, login: 'octo', name: 'octo' });
  if (url === 'https://api.github.com/user/emails') return json([{ email: 'octo@example.test', primary: true, verified: true }]);
  throw new Error(`unexpected fetch ${url}`);
});

const sharedRedis = new RedisMock();

function loadPod(redis: any): express.Express {
  let app!: express.Express;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/lib/redis').setRedisClientForTests(redis);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const router = require('../../src/routes/api').default;
    app = express();
    app.use(express.json());
    app.use('/api', router);
  });
  return app;
}

let podA: express.Express;
let podB: express.Express;

beforeAll(() => {
  (global as any).fetch = fetchMock;
  podA = loadPod(sharedRedis);
  podB = loadPod(sharedRedis.duplicate());
});

beforeEach(async () => {
  users.clear();
  await sharedRedis.flushall();
});

function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] || []);
  const c = raw.find((h) => h.startsWith(`${name}=`));
  return c ? c.split(';')[0].slice(name.length + 1) : undefined;
}

describe('GitHub login across replicas', () => {
  it('start on pod A, callback on pod B, exchange on pod A', async () => {
    const start = await request(podA).get('/api/auth/github');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const cookie = cookieValue(start, 'plat_oauth_state');
    expect(cookie).toBe(state);
    // The state is in Redis under the API prefix, not in pod A's memory.
    expect(await sharedRedis.exists(`plat:api:oauth-state:${state}`)).toBe(1);

    const cb = await request(podB)
      .get('/api/auth/github/callback')
      .set('Cookie', `plat_oauth_state=${cookie}`)
      .query({ code: 'gh-code', state });
    const location = new URL(cb.headers.location);
    expect(location.pathname).toBe('/dashboard');
    const code = location.searchParams.get('code')!;

    const ex = await request(podA).post('/api/auth/exchange').send({ code });
    expect(ex.status).toBe(200);
    expect((jwt.verify(ex.body.token, JWT_SECRET) as any).email).toBe('octo@example.test');

    // Single use across replicas: neither pod accepts the state or the code again.
    const replayState = await request(podA)
      .get('/api/auth/github/callback')
      .set('Cookie', `plat_oauth_state=${cookie}`)
      .query({ code: 'gh-code', state });
    expect(replayState.headers.location).toMatch(/\/login\?error=/);
    expect((await request(podB).post('/api/auth/exchange').send({ code })).status).toBe(400);
  });

  it('a code can be redeemed only once even when two pods race', async () => {
    const start = await request(podA).get('/api/auth/github');
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const cb = await request(podB).get('/api/auth/github/callback').set('Cookie', `plat_oauth_state=${state}`).query({ code: 'gh-code', state });
    const code = new URL(cb.headers.location).searchParams.get('code')!;
    const [a, b] = await Promise.all([
      request(podA).post('/api/auth/exchange').send({ code }),
      request(podB).post('/api/auth/exchange').send({ code }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });
});

describe('OIDC authorize → token across replicas', () => {
  const user = { id: '00000000-0000-0000-0000-0000000000aa', name: 'Dev', email: 'dev@example.test', role: 'devops', roleId: null, isActive: true };

  it('authorize on pod A, token on pod B', async () => {
    users.set(user.id, user);
    const portalToken = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    const auth = await request(podA)
      .post('/api/oauth/authorize')
      .set('Authorization', `Bearer ${portalToken}`)
      .send({ client_id: 'argocd', redirect_uri: ARGO_REDIRECT, response_type: 'code', state: 's1', scope: 'openid email' });
    expect(auth.status).toBe(200);
    const code = new URL(auth.body.redirect).searchParams.get('code')!;

    const token = await request(podB)
      .post('/api/oauth/token')
      .set('Authorization', basic('argocd', 'argocd-test-secret-0123456789'))
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: ARGO_REDIRECT });
    expect(token.status).toBe(200);
    expect(token.body.id_token).toBeTruthy();

    const again = await request(podA)
      .post('/api/oauth/token')
      .set('Authorization', basic('argocd', 'argocd-test-secret-0123456789'))
      .type('form')
      .send({ grant_type: 'authorization_code', code, redirect_uri: ARGO_REDIRECT });
    expect(again.status).toBe(400);
  });
});

describe('fail closed when Redis is unavailable', () => {
  const down: any = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? undefined : () => Promise.reject(new Error('connect ECONNREFUSED'))),
  });
  let podDown: express.Express;
  beforeAll(() => { podDown = loadPod(down); });

  it('login start answers 503 instead of issuing an unshareable state', async () => {
    const r = await request(podDown).get('/api/auth/github');
    expect(r.status).toBe(503);
  });

  it('code exchange answers 503', async () => {
    const r = await request(podDown).post('/api/auth/exchange').send({ code: 'a'.repeat(43) });
    expect(r.status).toBe(503);
  });

  it('OIDC token endpoint answers 503 temporarily_unavailable', async () => {
    const r = await request(podDown)
      .post('/api/oauth/token')
      .set('Authorization', basic('argocd', 'argocd-test-secret-0123456789'))
      .type('form')
      .send({ grant_type: 'authorization_code', code: 'a'.repeat(43), redirect_uri: ARGO_REDIRECT });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('temporarily_unavailable');
  });

  it('a callback while Redis is down redirects to the login error page', async () => {
    const r = await request(podDown)
      .get('/api/auth/github/callback')
      .set('Cookie', 'plat_oauth_state=abc')
      .query({ code: 'gh-code', state: 'abc' });
    expect(r.headers.location).toMatch(/\/login\?error=/);
    expect(users.size).toBe(0);
  });
});
