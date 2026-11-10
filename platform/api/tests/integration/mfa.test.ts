/**
 * #24 end-to-end through the API router (in-memory repositories, controlled clock):
 * password + GitHub login state machine, forced enrolment, step-up for secret reveal,
 * replay protection, single-use recovery codes, admin reset, policy and audit entries.
 */
process.env.MFA_RATE_LIMIT_MAX = '5';

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
    getOrCreateIntegrationSettings: jest.fn(async () => {
      const repo = mockRepo('IntegrationSettings');
      const [row] = await repo.find();
      return row || repo.create({ id: 'settings-1', mfaRequiredRoles: null });
    }),
  };
});

import { MemoryRepo } from '../helpers/memory-repo';

const mockRepos: Record<string, MemoryRepo<any>> = {};
function mockRepo(name: string): MemoryRepo<any> {
  if (!mockRepos[name]) mockRepos[name] = new MemoryRepo();
  return mockRepos[name];
}
jest.mock('../../src/config/database', () => ({
  getDb: jest.fn(async () => ({
    getRepository: (entity: any) => mockRepo(typeof entity === 'string' ? entity : entity?.name),
  })),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import apiRouter from '../../src/routes/api';
import { encryptValue } from '../../src/lib/secrets-encryption';
import { encryptTotpSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, totpCode } from '../../src/lib/mfa';
import { signSessionToken } from '../../src/lib/session-token';

const JWT_SECRET = (process.env.JWT_SECRET = 'mfa-integration-test-jwt-secret-0123456789');
process.env.SECRETS_ENCRYPTION_KEY = 'mfa-integration-test-encryption-key';
const PASSWORD = 'correct-horse-battery';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

let clock = Date.UTC(2026, 10, 9, 12, 0, 5);
const tick = (ms = 30_000) => { clock += ms; };

let app: express.Express;
let passwordHash: string;

const ADMIN = { id: 'aaaaaaaa-0000-4000-8000-000000000001', email: 'admin@example.test', username: 'admin', name: 'Admin', role: 'admin' };
const DEVOPS = { id: 'aaaaaaaa-0000-4000-8000-000000000002', email: 'ops@example.test', username: 'ops', name: 'Ops', role: 'devops' };
const DEV = { id: 'aaaaaaaa-0000-4000-8000-000000000003', email: 'dev@example.test', username: 'dev', name: 'Dev', role: 'developer' };
const LIMITED = { id: 'aaaaaaaa-0000-4000-8000-000000000004', email: 'limited@example.test', username: 'limited', name: 'Limited', role: 'developer' };

function seedUser(u: typeof ADMIN, extra: Record<string, unknown> = {}) {
  mockRepo('User').rows.push({ ...u, passwordHash, roleId: null, isActive: true, githubId: null, gitlabId: null, ...extra });
}

/** Enrol `userId` directly in the store; returns its secret and recovery codes. */
async function seedMfa(userId: string): Promise<{ secret: string; codes: string[] }> {
  const secret = generateTotpSecret();
  await mockRepo('UserMfa').save({ userId, secretEncrypted: encryptTotpSecret(secret), enabledAt: new Date(clock), lastUsedStep: 0 });
  const codes = generateRecoveryCodes();
  for (const c of codes) await mockRepo('MfaRecoveryCode').save({ userId, codeHash: await hashRecoveryCode(c), usedAt: null });
  return { secret, codes };
}

const actions = () => mockRepo('AuditLog').rows.map((r) => r.action);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
  process.env.DOMAIN = 'platform.example.test';
  app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
});

afterAll(() => jest.restoreAllMocks());

beforeEach(() => {
  for (const k of Object.keys(mockRepos)) delete mockRepos[k];
  delete process.env.MFA_REQUIRED_ROLES;
  tick(60 * 60 * 1000); // fresh rate-limit windows and TOTP steps per test
  seedUser(ADMIN);
  seedUser(DEVOPS);
  seedUser(DEV);
  seedUser(LIMITED);
});

async function passwordLogin(email: string, password = PASSWORD) {
  return request(app).post('/api/auth/login').send({ email, password });
}

describe('password login state machine', () => {
  it('returns mfa_required + a challenge token (no session) when MFA is enabled', async () => {
    await seedMfa(DEV.id);
    const r = await passwordLogin(DEV.email);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mfa_required: true, status: 'mfa_required', expiresIn: 300 });
    expect(r.body.token).toBeUndefined();
    expect(r.body.user).toBeUndefined();
    // The challenge token is not a session.
    const me = await request(app).get('/api/users/me').set(bearer(r.body.challengeToken));
    expect(me.status).toBe(401);
  });

  it('a wrong password never reaches the second factor', async () => {
    await seedMfa(DEV.id);
    const r = await passwordLogin(DEV.email, 'wrong-password');
    expect(r.status).toBe(401);
    expect(r.body.challengeToken).toBeUndefined();
  });

  it('valid password + wrong or reused TOTP fails; a fresh TOTP completes the login', async () => {
    const { secret } = await seedMfa(DEV.id);
    const { challengeToken } = (await passwordLogin(DEV.email)).body;

    const wrong = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken, code: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('invalid_code');
    expect(wrong.body.token).toBeUndefined();

    const code = totpCode(secret, clock);
    const ok = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken, code });
    expect(ok.status).toBe(200);
    const claims: any = jwt.verify(ok.body.token, JWT_SECRET);
    expect(claims).toMatchObject({ id: DEV.id, amr: ['pwd', 'otp', 'mfa'] });
    expect(claims.auth_time).toBe(Math.floor(clock / 1000));
    expect(ok.body.user.passwordHash).toBeUndefined();

    // Same code again (new login): rejected as a replay.
    const again = (await passwordLogin(DEV.email)).body.challengeToken;
    const replay = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: again, code });
    expect(replay.status).toBe(401);
    expect(mockRepo('AuditLog').rows.some((a) => a.action === 'auth.mfa.challenge_failed' && a.metadata?.reason === 'replay')).toBe(true);
  });

  it('a recovery code works exactly once', async () => {
    const { codes } = await seedMfa(DEV.id);
    const first = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: (await passwordLogin(DEV.email)).body.challengeToken, code: codes[3] });
    expect(first.status).toBe(200);
    expect(first.body.recoveryCodesRemaining).toBe(9);
    const second = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: (await passwordLogin(DEV.email)).body.challengeToken, code: codes[3] });
    expect(second.status).toBe(401);
    expect(actions()).toEqual(expect.arrayContaining(['auth.mfa.challenge_succeeded', 'auth.mfa.recovery_code_used', 'auth.mfa.challenge_failed']));
  });

  it('rejects expired or forged challenge tokens', async () => {
    const { secret } = await seedMfa(DEV.id);
    const { challengeToken } = (await passwordLogin(DEV.email)).body;
    tick(6 * 60 * 1000);
    const late = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken, code: totpCode(secret, clock) });
    expect(late.status).toBe(401);
    expect(late.body.error).toBe('invalid_challenge');
    const forged = jwt.sign({ typ: 'mfa_challenge' }, 'not-the-secret', { subject: DEV.id, audience: 'platform-mfa-challenge' });
    const r = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: forged, code: totpCode(secret, clock) });
    expect(r.status).toBe(401);
  });

  it('rate-limits failed challenge attempts per account (shared limiter)', async () => {
    const { secret } = await seedMfa(LIMITED.id);
    const { challengeToken } = (await passwordLogin(LIMITED.email)).body;
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken, code: '111111' });
      expect(r.status).toBe(401);
    }
    const blocked = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken, code: totpCode(secret, clock) });
    expect(blocked.status).toBe(429);
  });
});

describe('forced enrolment (mfa.requiredRoles default [admin, devops])', () => {
  it('an admin without MFA is forced into enrolment before using the portal', async () => {
    const login = await passwordLogin(ADMIN.email);
    expect(login.status).toBe(200);
    expect(login.body.mfaEnrollmentRequired).toBe(true);
    const restricted = login.body.token;
    expect((jwt.decode(restricted) as any).mfa_enroll).toBe(true);
    expect(actions()).toContain('auth.mfa.enrollment_forced');

    const blocked = await request(app).get('/api/users').set(bearer(restricted));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe('mfa_enrollment_required');
    expect((await request(app).get('/api/users/me').set(bearer(restricted))).status).toBe(200);

    const status = await request(app).get('/api/auth/mfa/status').set(bearer(restricted));
    expect(status.body).toMatchObject({ enabled: false, required: true, session: { enrollmentOnly: true } });

    const enroll = await request(app).post('/api/auth/mfa/enroll').set(bearer(restricted));
    expect(enroll.status).toBe(200);
    expect(enroll.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(enroll.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(enroll.headers['cache-control']).toBe('no-store');

    const bad = await request(app).post('/api/auth/mfa/verify').set(bearer(restricted)).send({ code: '000000' });
    expect(bad.status).toBe(400);

    const verify = await request(app).post('/api/auth/mfa/verify').set(bearer(restricted)).send({ code: totpCode(enroll.body.secret, clock) });
    expect(verify.status).toBe(200);
    expect(verify.body.recoveryCodes).toHaveLength(10);
    const full: any = jwt.verify(verify.body.token, JWT_SECRET);
    expect(full.mfa_enroll).toBeUndefined();
    expect(full.amr).toEqual(['pwd', 'otp', 'mfa']);

    const list = await request(app).get('/api/users').set(bearer(verify.body.token));
    expect(list.status).toBe(200);
    expect(list.body.find((u: any) => u.id === ADMIN.id).mfaEnabled).toBe(true);
    expect(list.body.find((u: any) => u.id === DEV.id).mfaEnabled).toBe(false);
    expect(actions()).toEqual(expect.arrayContaining(['auth.mfa.enroll_started', 'auth.mfa.enroll_failed', 'auth.mfa.enabled']));

    // Next login goes through the challenge.
    const next = await passwordLogin(ADMIN.email);
    expect(next.body.mfa_required).toBe(true);
  });

  it('developers are not forced by default; the policy setting changes that', async () => {
    const dev = await passwordLogin(DEV.email);
    expect(dev.body.mfaEnrollmentRequired).toBeUndefined();
    expect((jwt.decode(dev.body.token) as any).mfa_enroll).toBeUndefined();

    process.env.MFA_REQUIRED_ROLES = 'admin,devops,developer';
    const forced = await passwordLogin(DEV.email);
    expect(forced.body.mfaEnrollmentRequired).toBe(true);
  });
});

describe('step-up for secret reveal', () => {
  beforeEach(async () => {
    mockRepo('Secret').rows.push({
      id: 'secret-1', projectId: PROJECT_ID, environmentId: null, key: 'API_KEY',
      encryptedValue: encryptValue('s3cr3t-value', process.env.SECRETS_ENCRYPTION_KEY!), version: 1, isActive: true,
    });
  });

  const reveal = (token: string) =>
    request(app).post(`/api/projects/${PROJECT_ID}/secrets/reveal`).set(bearer(token)).send({ key: 'API_KEY' });

  it('401 step_up_required without a recent second factor; succeeds after step-up', async () => {
    const { secret } = await seedMfa(ADMIN.id);
    const session = signSessionToken(ADMIN, { amr: ['pwd'] }); // e.g. a session from before MFA
    const denied = await reveal(session);
    expect(denied.status).toBe(401);
    expect(denied.body).toMatchObject({ error: 'step_up_required', maxAgeSec: 900 });

    const wrong = await request(app).post('/api/auth/mfa/step-up').set(bearer(session)).send({ code: '000000' });
    expect(wrong.status).toBe(400);

    const up = await request(app).post('/api/auth/mfa/step-up').set(bearer(session)).send({ code: totpCode(secret, clock) });
    expect(up.status).toBe(200);
    const ok = await reveal(up.body.token);
    expect(ok.status).toBe(200);
    expect(ok.body.value).toBe('s3cr3t-value');

    // N minutes later the step-up has expired again.
    tick(16 * 60 * 1000);
    const stale = await reveal(up.body.token);
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe('step_up_required');
    expect(actions()).toEqual(expect.arrayContaining(['auth.mfa.step_up_failed', 'auth.mfa.step_up', 'secrets.reveal']));
  });

  it('a login completed with MFA can reveal right away', async () => {
    const { secret } = await seedMfa(ADMIN.id);
    const { challengeToken } = (await passwordLogin(ADMIN.email)).body;
    const login = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken, code: totpCode(secret, clock) });
    expect((await reveal(login.body.token)).status).toBe(200);
  });

  it('step-up needs an enrolled factor', async () => {
    const session = signSessionToken(DEV, { amr: ['pwd'] });
    const r = await request(app).post('/api/auth/mfa/step-up').set(bearer(session)).send({ code: '123456' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('mfa_not_enrolled');
  });
});

describe('GitHub login state machine', () => {
  const fetchMock = jest.fn(async (url: string) => {
    const json = (body: unknown) => ({ json: async () => body }) as any;
    if (url.startsWith('https://github.com/login/oauth/access_token')) return json({ access_token: 'gh-access' });
    if (url === 'https://api.github.com/user') return json({ id: 777, login: 'devgh', name: 'Dev' });
    if (url === 'https://api.github.com/user/emails') return json([{ email: DEV.email, primary: true, verified: true }]);
    throw new Error(`unexpected fetch ${url}`);
  });

  async function githubExchange() {
    (global as any).fetch = fetchMock;
    const start = await request(app).get('/api/auth/github');
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const cb = await request(app).get('/api/auth/github/callback').set('Cookie', `plat_oauth_state=${state}`).query({ code: 'gh-code', state });
    const code = new URL(cb.headers.location).searchParams.get('code')!;
    return request(app).post('/api/auth/exchange').send({ code });
  }

  it('does not hand out a session before the second factor', async () => {
    const { secret } = await seedMfa(DEV.id);
    const ex = await githubExchange();
    expect(ex.status).toBe(200);
    expect(ex.body.mfa_required).toBe(true);
    expect(ex.body.token).toBeUndefined();
    const done = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: ex.body.challengeToken, code: totpCode(secret, clock) });
    expect(done.status).toBe(200);
    expect((jwt.decode(done.body.token) as any).amr).toEqual(['fed', 'otp', 'mfa']);
  });

  it('forces enrolment for a GitHub-linked admin without MFA', async () => {
    mockRepo('User').rows.find((u) => u.id === DEV.id).role = 'admin';
    const ex = await githubExchange();
    expect(ex.body.mfaEnrollmentRequired).toBe(true);
    const claims: any = jwt.decode(ex.body.token);
    expect(claims).toMatchObject({ mfa_enroll: true, amr: ['fed'] });
  });
});

describe('managing the factor', () => {
  it('admin reset of another user is audit-logged and needs a recent admin second factor', async () => {
    await seedMfa(DEV.id);
    const { secret } = await seedMfa(ADMIN.id);
    const plain = signSessionToken(ADMIN, { amr: ['pwd'] });
    const denied = await request(app).post(`/api/users/${DEV.id}/mfa/reset`).set(bearer(plain)).send({});
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe('step_up_required');

    const up = await request(app).post('/api/auth/mfa/step-up').set(bearer(plain)).send({ code: totpCode(secret, clock) });
    const r = await request(app).post(`/api/users/${DEV.id}/mfa/reset`).set(bearer(up.body.token)).send({ reason: 'lost phone' });
    expect(r.status).toBe(200);
    expect(r.body.hadMfa).toBe(true);
    expect(mockRepo('UserMfa').rows.some((m) => m.userId === DEV.id)).toBe(false);
    expect(mockRepo('MfaRecoveryCode').rows.some((m) => m.userId === DEV.id)).toBe(false);
    const entry = mockRepo('AuditLog').rows.find((a) => a.action === 'auth.mfa.admin_reset');
    expect(entry).toMatchObject({ userId: ADMIN.id, targetId: DEV.id });
    expect(entry.metadata.reason).toBe('lost phone');

    const opsToken = signSessionToken(DEVOPS, { amr: ['pwd', 'otp', 'mfa'] });
    expect((await request(app).post(`/api/users/${DEV.id}/mfa/reset`).set(bearer(opsToken))).status).toBe(403);
  });

  it('a developer can disable with a current code; admins cannot while policy requires MFA', async () => {
    const { secret } = await seedMfa(DEV.id);
    const devToken = signSessionToken(DEV, { amr: ['pwd', 'otp', 'mfa'] });
    expect((await request(app).post('/api/auth/mfa/disable').set(bearer(devToken)).send({ code: '000000' })).status).toBe(400);
    const off = await request(app).post('/api/auth/mfa/disable').set(bearer(devToken)).send({ code: totpCode(secret, clock) });
    expect(off.status).toBe(200);
    expect(mockRepo('UserMfa').rows).toHaveLength(0);

    const { secret: adminSecret } = await seedMfa(ADMIN.id);
    const adminToken = signSessionToken(ADMIN, { amr: ['pwd', 'otp', 'mfa'] });
    const refused = await request(app).post('/api/auth/mfa/disable').set(bearer(adminToken)).send({ code: totpCode(adminSecret, clock) });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('mfa_required_by_policy');
    expect(actions()).toEqual(expect.arrayContaining(['auth.mfa.disable_failed', 'auth.mfa.disabled']));
  });

  it('regenerates recovery codes (old ones stop working)', async () => {
    const { secret, codes } = await seedMfa(DEV.id);
    const token = signSessionToken(DEV, { amr: ['pwd', 'otp', 'mfa'] });
    const r = await request(app).post('/api/auth/mfa/recovery-codes').set(bearer(token)).send({ code: totpCode(secret, clock) });
    expect(r.status).toBe(200);
    expect(r.body.recoveryCodes).toHaveLength(10);
    expect(r.body.recoveryCodes).not.toContain(codes[0]);
    const old = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: (await passwordLogin(DEV.email)).body.challengeToken, code: codes[0] });
    expect(old.status).toBe(401);
    const fresh = await request(app).post('/api/auth/mfa/challenge').send({ challengeToken: (await passwordLogin(DEV.email)).body.challengeToken, code: r.body.recoveryCodes[0] });
    expect(fresh.status).toBe(200);
    expect(actions()).toContain('auth.mfa.recovery_codes_regenerated');
  });

  it('enrolment refuses a second authenticator while one is active', async () => {
    await seedMfa(DEV.id);
    const token = signSessionToken(DEV, { amr: ['pwd', 'otp', 'mfa'] });
    const r = await request(app).post('/api/auth/mfa/enroll').set(bearer(token));
    expect(r.status).toBe(409);
  });

  it('agent tokens cannot manage MFA', async () => {
    const r = await request(app).get('/api/auth/mfa/status').set(bearer('plat_agent_00000000000000000000000000'));
    expect(r.status).toBe(401);
  });
});

describe('policy setting mfa.requiredRoles', () => {
  it('admin with a recent second factor updates it (audited); others cannot', async () => {
    const admin = signSessionToken(ADMIN, { amr: ['pwd', 'otp', 'mfa'] });
    const get = await request(app).get('/api/settings/mfa').set(bearer(admin));
    expect(get.body).toMatchObject({ requiredRoles: ['admin', 'devops'], source: 'default' });

    expect((await request(app).put('/api/settings/mfa').set(bearer(admin)).send({ requiredRoles: ['root'] })).status).toBe(400);
    const put = await request(app).put('/api/settings/mfa').set(bearer(admin)).send({ requiredRoles: ['admin', 'devops', 'tech_lead'] });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/settings/mfa').set(bearer(admin))).body).toMatchObject({ requiredRoles: ['admin', 'devops', 'tech_lead'], source: 'setting' });
    expect(mockRepo('AuditLog').rows.find((a) => a.action === 'settings.mfa.updated').metadata).toEqual({
      setting: 'mfa.requiredRoles', before: ['admin', 'devops'], after: ['admin', 'devops', 'tech_lead'],
    });

    const ops = signSessionToken(DEVOPS, { amr: ['pwd', 'otp', 'mfa'] });
    expect((await request(app).put('/api/settings/mfa').set(bearer(ops)).send({ requiredRoles: [] })).status).toBe(403);
    const noStepUp = signSessionToken(ADMIN, { amr: ['pwd'] });
    expect((await request(app).put('/api/settings/mfa').set(bearer(noStepUp)).send({ requiredRoles: [] })).status).toBe(401);
  });
});
