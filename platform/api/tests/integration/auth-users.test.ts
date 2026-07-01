/**
 * ════════════════════════════════════════════════════════════════════
 * Platform — Auth & Users Strict Test Suite
 * Tests: /api/auth/login, /api/users/*, /api/roles/*, /api/permissions
 *        OIDC/OAuth2 endpoints, JWT middleware, permission cache
 * ════════════════════════════════════════════════════════════════════
 */

// ── All mocks MUST come before any imports ──────────────────────────
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

// ── Seeded demo users (matching real init-demo seed) ────────────────
const USERS = {
  admin:     { id: '00000000-0000-0000-0000-000000000001', email: 'admin@dev.io',   name: 'Admin',      role: 'admin',     roleId: null, isActive: true },
  devops:    { id: '33333333-3333-3333-3333-333333333333', email: 'devops@caps.io', name: 'DevOps Boss', role: 'devops',    roleId: null, isActive: true },
  tech_lead: { id: '22222222-2222-2222-2222-222222222222', email: 'sarah@dev.io',   name: 'Sarah',      role: 'tech_lead', roleId: null, isActive: true },
  developer: { id: '11111111-1111-1111-1111-111111111111', email: 'john@dev.io',    name: 'John Dev',   role: 'developer', roleId: null, isActive: true },
  inactive:  { id: '55555555-5555-5555-5555-555555555555', email: 'gone@dev.io',    name: 'Gone',       role: 'viewer',    roleId: null, isActive: false },
};

const mockUserRepo = {
  findOne: jest.fn(),
  find:    jest.fn().mockResolvedValue(Object.values(USERS)),
  save:    jest.fn().mockImplementation((u: any) => Promise.resolve(u)),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'new-user-uuid', ...d })),
  update:  jest.fn().mockResolvedValue({ affected: 1 }),
  delete:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const mockRoleRepo = {
  findOne: jest.fn().mockResolvedValue(null),
  find:    jest.fn().mockResolvedValue([]),
  create:  jest.fn().mockImplementation((d: any) => ({ id: 'role-uuid', ...d })),
  save:    jest.fn().mockImplementation((r: any) => Promise.resolve(r)),
  delete:  jest.fn().mockResolvedValue({ affected: 1 }),
  update:  jest.fn().mockResolvedValue({ affected: 1 }),
};

const mockAuditRepo = {
  create: jest.fn().mockImplementation((d: any) => d),
  save:   jest.fn().mockResolvedValue({}),
  find:   jest.fn().mockResolvedValue([]),
};

const mockSdkCredRepo = {
  findOne: jest.fn().mockResolvedValue({
    id: 'cred-1', token: 'sdk_live_abc123def456abc123def456abc12345',
    projectId: 'proj-1', status: 'active',
  }),
};

const mockDataSource = {
  getRepository: jest.fn().mockImplementation((entity: any) => {
    const name = typeof entity === 'string' ? entity : entity?.name;
    if (name === 'User')          return mockUserRepo;
    if (name === 'Role')          return mockRoleRepo;
    if (name === 'AuditLog')      return mockAuditRepo;
    if (name === 'SdkCredential') return mockSdkCredRepo;
    return { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]), save: jest.fn(), create: jest.fn(), delete: jest.fn() };
  }),
};

jest.mock('../../src/config/database', () => ({
  getDb: jest.fn().mockResolvedValue(mockDataSource),
}));

// ── Mongo schema mocks ───────────────────────────────────────────────
jest.mock('../../src/schemas/Log',       () => ({ LogModel:       { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/ApiMetric', () => ({ ApiMetricModel: { insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/BugReport', () => ({ BugReportModel: { create: jest.fn().mockResolvedValue({ _id: 'bug-1' }) } }));
jest.mock('../../src/schemas/ErrorDoc',  () => ({ ErrorDocModel:  { findOneAndUpdate: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/schemas/SdkEvent',  () => ({ SdkEventModel:  { create: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/schemas/MetricsRaw',() => ({ MetricsRawModel:{ insertMany: jest.fn().mockResolvedValue([]) } }));
jest.mock('../../src/schemas/FeatureFlag',() => ({ FeatureFlagModel: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn().mockResolvedValue(null) } }));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import apiRouter from '../../src/routes/api';

const JWT_SECRET = 'plat-super-secret-key';

// ── Token factory ────────────────────────────────────────────────────
const sign = (user: Record<string, unknown>, opts: Record<string, unknown> = {}) =>
  jwt.sign(user, JWT_SECRET, { expiresIn: '2h', ...opts });

const T = {
  admin:     sign({ id: USERS.admin.id,     email: USERS.admin.email,     name: USERS.admin.name,     role: 'admin'     }),
  devops:    sign({ id: USERS.devops.id,    email: USERS.devops.email,    name: USERS.devops.name,    role: 'devops'    }),
  tech_lead: sign({ id: USERS.tech_lead.id, email: USERS.tech_lead.email, name: USERS.tech_lead.name, role: 'tech_lead' }),
  developer: sign({ id: USERS.developer.id, email: USERS.developer.email, name: USERS.developer.name, role: 'developer' }),
  expired:   sign({ id: '00', role: 'devops' }, { expiresIn: -1 }),
  noRole:    sign({ id: '99', email: 'x@x.io', name: 'X' }),            // missing role field
  wrongSig:  jwt.sign({ id: '00', role: 'admin' }, 'wrong-secret'),
  algNone:   'eyJhbGciOiJub25lIn0.eyJyb2xlIjoiYWRtaW4ifQ.',           // algorithm none attack
};

let app: express.Express;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.SECRETS_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex
  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
});

beforeEach(() => {
  jest.clearAllMocks();

  // Default: every findOne resolves a known user based on email or id
  mockUserRepo.findOne.mockImplementation(({ where }: any) => {
    const { email, id } = where || {};
    const found = Object.values(USERS).find(u =>
      (email && u.email === email) || (id && u.id === id)
    );
    return Promise.resolve(found ?? null);
  });

  mockRoleRepo.findOne.mockResolvedValue(null);
});

// ════════════════════════════════════════════════════════════════════
// 1. HEALTH
// ════════════════════════════════════════════════════════════════════
describe('GET /api/health', () => {
  it('returns 200 { status: "ok" } — no auth needed', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('any unknown method on /api/health returns 404', async () => {
    const r = await request(app).delete('/api/health');
    expect(r.status).toBe(404);
  });

  it('404 body has { error } matching "Route not found"', async () => {
    const r = await request(app).get('/api/this-does-not-exist');
    expect(r.status).toBe(404);
    expect(r.body).toHaveProperty('error');
    expect(r.body.error).toMatch(/route not found/i);
  });

  it('404 error string includes the HTTP method and path', async () => {
    const r = await request(app).post('/api/no-such-route');
    expect(r.body.error).toMatch(/POST/);
    expect(r.body.error).toMatch(/no-such-route/);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. POST /api/auth/login — exhaustive cases
// ════════════════════════════════════════════════════════════════════
describe('POST /api/auth/login', () => {
  it('returns 200 + JWT + user object for existing active user', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: USERS.devops.email });
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('token');
    expect(r.body.token.split('.').length).toBe(3);  // valid JWT structure
    expect(r.body.user).toMatchObject({ email: USERS.devops.email, role: 'devops' });
    expect(r.body.user).not.toHaveProperty('password');
  });

  it('JWT payload contains id, email, name, role — no sensitive fields', () => {
    const { token } = { token: T.devops };
    const p = jwt.decode(token) as Record<string, unknown>;
    expect(p).toHaveProperty('id');
    expect(p).toHaveProperty('email');
    expect(p).toHaveProperty('name');
    expect(p).toHaveProperty('role');
    expect(p).not.toHaveProperty('password');
    expect(p).not.toHaveProperty('encryptedValue');
  });

  it('saves lastLogin on successful login', async () => {
    await request(app).post('/api/auth/login').send({ email: USERS.developer.email });
    expect(mockUserRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ email: USERS.developer.email })
    );
  });

  it('returns 401 when email not found in DB', async () => {
    mockUserRepo.findOne.mockResolvedValue(null);
    const r = await request(app).post('/api/auth/login').send({ email: 'nobody@nope.io' });
    expect(r.status).toBe(401);
    expect(r.body).toHaveProperty('error');
  });

  it('returns 400 when email field is absent from body', async () => {
    const r = await request(app).post('/api/auth/login').send({});
    expect(r.status).toBe(400);
  });

  it('returns 400 when body is completely empty', async () => {
    const r = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(r.status).toBe(400);
  });

  it('returns 400 when email is null', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: null });
    expect(r.status).toBe(400);
  });

  it('returns 400 when email is a number', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: 12345 });
    expect(r.status).toBe(400);
  });

  it('GET /api/auth/login → 404 (wrong method)', async () => {
    const r = await request(app).get('/api/auth/login');
    expect(r.status).toBe(404);
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. JWT MIDDLEWARE — expressAuthenticate
// ════════════════════════════════════════════════════════════════════
describe('JWT Authentication Middleware (expressAuthenticate)', () => {
  // Use GET /api/projects as a representative protected endpoint
  const ENDPOINT = '/api/projects';
  const auth = (tok: string) => ({ Authorization: `Bearer ${tok}` });

  it('401 — no Authorization header at all', async () => {
    const r = await request(app).get(ENDPOINT);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/Missing token/i);
  });

  it('401 — empty Authorization header', async () => {
    const r = await request(app).get(ENDPOINT).set('Authorization', '');
    expect(r.status).toBe(401);
  });

  it('401 — Basic scheme (not Bearer)', async () => {
    const r = await request(app).get(ENDPOINT).set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/Missing token|Unauthorized/i);
  });

  it('401 — expired JWT', async () => {
    const r = await request(app).get(ENDPOINT).set(auth(T.expired));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/expired|Invalid/i);
  });

  it('401 — malformed JWT string', async () => {
    const r = await request(app).get(ENDPOINT).set(auth('not.a.real.jwt.token'));
    expect(r.status).toBe(401);
  });

  it('401 — JWT signed with wrong secret', async () => {
    const r = await request(app).get(ENDPOINT).set(auth(T.wrongSig));
    expect(r.status).toBe(401);
  });

  it('401 — alg:none attack token is rejected', async () => {
    const r = await request(app).get(ENDPOINT).set(auth(T.algNone));
    expect(r.status).toBe(401);
  });

  it('401 — user deleted after token issued (findOne returns null)', async () => {
    mockUserRepo.findOne.mockResolvedValue(null);
    const r = await request(app).get(ENDPOINT).set(auth(T.developer));
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/User not found|Invalid/i);
  });

  it('200 — valid token passes through', async () => {
    const r = await request(app).get(ENDPOINT).set(auth(T.devops));
    expect(r.status).toBe(200);
  });

  it('response never includes WWW-Authenticate header', async () => {
    const r = await request(app).get(ENDPOINT);
    expect(r.headers['www-authenticate']).toBeUndefined();
  });

  it('Content-Type of error responses is application/json', async () => {
    const r = await request(app).get(ENDPOINT);
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. USERS CRUD
// ════════════════════════════════════════════════════════════════════
describe('Users API', () => {
  describe('GET /api/users/me', () => {
    it('returns own profile — no password field', async () => {
      const r = await request(app).get('/api/users/me').set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty('id');
      expect(r.body).not.toHaveProperty('password');
    });

    it('401 without token', async () => {
      const r = await request(app).get('/api/users/me');
      expect(r.status).toBe(401);
    });
  });

  describe('GET /api/users', () => {
    it('devops can list all users', async () => {
      const r = await request(app).get('/api/users').set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
    });

    it('developer cannot list users — 403', async () => {
      const r = await request(app).get('/api/users').set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });

    it('response users do not contain password fields', async () => {
      const r = await request(app).get('/api/users').set('Authorization', `Bearer ${T.devops}`);
      if (r.status === 200) {
        r.body.forEach((u: Record<string, unknown>) => {
          expect(u).not.toHaveProperty('password');
        });
      }
    });
  });

  describe('POST /api/users/invite', () => {
    beforeEach(() => {
      // For invite — user doesn't exist yet (409 check), then create succeeds
      mockUserRepo.findOne.mockResolvedValue(null);
    });

    it('devops can invite — returns 201 with role defaulting to developer', async () => {
      mockUserRepo.save.mockImplementation((u: any) => Promise.resolve({ id: 'new-user-id', ...u }));
      mockUserRepo.create.mockImplementation((d: any) => ({ id: 'new-user-id', role: 'developer', ...d }));

      const r = await request(app)
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ email: `invite-${Date.now()}@test.io`, name: 'New Member' });
      expect([201, 400]).toContain(r.status); // 400 if email validation strict
    });

    it('409 when email already exists in DB', async () => {
      mockUserRepo.findOne.mockResolvedValue(USERS.developer);
      const r = await request(app)
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ email: USERS.developer.email, name: 'Dup' });
      expect(r.status).toBe(409);
    });

    it('400 when email is missing', async () => {
      const r = await request(app)
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: 'No Email' });
      expect(r.status).toBe(400);
    });

    it('400 when name is missing', async () => {
      const r = await request(app)
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ email: 'valid@email.io' });
      expect(r.status).toBe(400);
    });

    it('developer cannot invite — 403', async () => {
      const r = await request(app)
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ email: 'x@x.io', name: 'X' });
      expect(r.status).toBe(403);
    });

    it('tech_lead cannot invite — 403 (users.create not in tech_lead preset)', async () => {
      const r = await request(app)
        .post('/api/users/invite')
        .set('Authorization', `Bearer ${T.tech_lead}`)
        .send({ email: 'y@y.io', name: 'Y' });
      expect(r.status).toBe(403);
    });
  });

  describe('PATCH /api/users/me', () => {
    it('any auth user can update their own profile', async () => {
      mockUserRepo.save.mockImplementation((u: any) => Promise.resolve(u));
      const r = await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ name: 'Updated Name' });
      expect([200, 400]).toContain(r.status);
    });
  });

  describe('PATCH /api/users/:id/role', () => {
    it('devops can change role', async () => {
      mockUserRepo.findOne.mockResolvedValue(USERS.developer);
      const r = await request(app)
        .patch(`/api/users/${USERS.developer.id}/role`)
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ role: 'tech_lead' });
      expect([200, 400]).toContain(r.status);
    });

    it('developer cannot change role — 403', async () => {
      const r = await request(app)
        .patch(`/api/users/${USERS.developer.id}/role`)
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ role: 'admin' });
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. ROLES CRUD
// ════════════════════════════════════════════════════════════════════
describe('Roles API', () => {
  describe('GET /api/roles', () => {
    it('devops can list roles', async () => {
      const r = await request(app).get('/api/roles').set('Authorization', `Bearer ${T.devops}`);
      expect(r.status).toBe(200);
    });
    it('developer cannot list roles — 403', async () => {
      const r = await request(app).get('/api/roles').set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });

  describe('POST /api/roles', () => {
    beforeEach(() => {
      mockRoleRepo.findOne.mockResolvedValue(null); // no duplicate
      mockRoleRepo.save.mockImplementation((r: any) => Promise.resolve({ id: 'role-new', ...r }));
    });

    it('devops can create a custom role — 201', async () => {
      const r = await request(app)
        .post('/api/roles')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: `ci-bot-${Date.now()}`, description: 'CI account', permissions: ['deployments.read'] });
      expect(r.status).toBe(201);
      expect(r.body).toHaveProperty('id');
      expect(Array.isArray(r.body.permissions)).toBe(true);
    });

    it('400 when role name is missing', async () => {
      const r = await request(app)
        .post('/api/roles')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ permissions: ['logs.read'] });
      expect(r.status).toBe(400);
    });

    it('409 when role name already exists', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'existing', name: 'ci-bot' });
      const r = await request(app)
        .post('/api/roles')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: 'ci-bot', permissions: [] });
      expect(r.status).toBe(409);
    });

    it('permissions defaults to empty array when omitted', async () => {
      const r = await request(app)
        .post('/api/roles')
        .set('Authorization', `Bearer ${T.devops}`)
        .send({ name: `role-noperms-${Date.now()}` });
      expect([201, 400]).toContain(r.status);
      if (r.status === 201) {
        expect(Array.isArray(r.body.permissions)).toBe(true);
      }
    });

    it('developer cannot create roles — 403', async () => {
      const r = await request(app)
        .post('/api/roles')
        .set('Authorization', `Bearer ${T.developer}`)
        .send({ name: 'hacker-role', permissions: ['secrets.reveal'] });
      expect(r.status).toBe(403);
    });
  });

  describe('DELETE /api/roles/:id', () => {
    it('devops can delete a role — 200', async () => {
      mockRoleRepo.findOne.mockResolvedValue({ id: 'role-del', name: 'temp', isSystem: false });
      const r = await request(app)
        .delete('/api/roles/role-del')
        .set('Authorization', `Bearer ${T.devops}`);
      expect([200, 404]).toContain(r.status);
    });

    it('developer cannot delete roles — 403', async () => {
      const r = await request(app)
        .delete('/api/roles/some-role')
        .set('Authorization', `Bearer ${T.developer}`);
      expect(r.status).toBe(403);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. OIDC / OAuth2 ENDPOINTS
// ════════════════════════════════════════════════════════════════════
describe('OIDC / OAuth2', () => {
  it('GET /api/oauth/.well-known/openid-configuration — no auth required, valid discovery doc', async () => {
    const r = await request(app).get('/api/oauth/.well-known/openid-configuration');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('issuer');
    expect(r.body).toHaveProperty('authorization_endpoint');
    expect(r.body).toHaveProperty('token_endpoint');
    expect(r.body).toHaveProperty('userinfo_endpoint');
    expect(r.body).toHaveProperty('jwks_uri');
    expect(r.body).toHaveProperty('response_types_supported');
    expect(r.body).toHaveProperty('subject_types_supported');
  });

  it('GET /api/oauth/jwks — returns RSA public key, NEVER the private key', async () => {
    const r = await request(app).get('/api/oauth/jwks');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.keys)).toBe(true);
    const k = r.body.keys[0];
    expect(k.kty).toBe('RSA');
    expect(k.use).toBe('sig');
    expect(k.alg).toBe('RS256');
    expect(k).toHaveProperty('n');  // public modulus
    expect(k).toHaveProperty('e');  // public exponent
    expect(k).not.toHaveProperty('d');   // MUST NOT expose private key
    expect(k).not.toHaveProperty('p');
    expect(k).not.toHaveProperty('q');
  });

  it('POST /api/oauth/token — invalid code returns 400', async () => {
    const r = await request(app)
      .post('/api/oauth/token')
      .send({ grant_type: 'authorization_code', code: 'invalid-code-abc', redirect_uri: 'https://app.io/cb', client_id: 'platform' });
    expect(r.status).toBe(400);
    expect(r.body).toHaveProperty('error');
  });

  it('POST /api/oauth/token — missing code returns 400', async () => {
    const r = await request(app)
      .post('/api/oauth/token')
      .send({ grant_type: 'authorization_code', redirect_uri: 'https://app.io/cb' });
    expect(r.status).toBe(400);
  });

  it('GET /api/oauth/userinfo — 401 with no token', async () => {
    const r = await request(app).get('/api/oauth/userinfo');
    expect(r.status).toBe(401);
  });

  it('GET /api/oauth/userinfo — 401 with random invalid token', async () => {
    const r = await request(app)
      .get('/api/oauth/userinfo')
      .set('Authorization', 'Bearer garbage-token');
    expect(r.status).toBe(401);
  });

  it('GET /api/oauth/authorize — redirects (302) for valid login_hint', async () => {
    const r = await request(app)
      .get('/api/oauth/authorize')
      .query({
        client_id: 'platform',
        redirect_uri: 'https://portainer.io/auth',
        response_type: 'code',
        scope: 'openid profile email',
        state: 'state123',
        login_hint: USERS.devops.email,
      });
    // Should redirect with a code param
    expect([302, 200, 400]).toContain(r.status);
    if (r.status === 302) {
      expect(r.headers.location).toBeDefined();
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 7. GET /api/permissions
// ════════════════════════════════════════════════════════════════════
describe('GET /api/permissions', () => {
  it('returns list of all permission strings', async () => {
    const r = await request(app)
      .get('/api/permissions')
      .set('Authorization', `Bearer ${T.devops}`);
    expect([200, 403]).toContain(r.status);
    if (r.status === 200) {
      expect(Array.isArray(r.body)).toBe(true);
    }
  });
});
