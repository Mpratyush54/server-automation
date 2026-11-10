/**
 * #24: requireRecentMfa (step-up), session claims parsed by expressAuthenticate, enrolment-only
 * sessions and refusal of MFA challenge tokens as sessions.
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../../../src/config/database', () => ({ getDb: jest.fn() }));
const { getDb } = require('../../../src/config/database');

import {
  AuthenticatedRequest,
  allowedDuringEnrollment,
  expressAuthenticate,
  hasRecentMfa,
  requireRecentMfa,
  stepUpMaxAgeSec,
} from '../../../src/middleware/auth';
import { signMfaChallenge, signSessionToken } from '../../../src/lib/session-token';

const JWT_SECRET = 'step-up-unit-test-jwt-secret-0123456789';
const USER = { id: 'user-1', role: 'admin', roleId: null, name: 'Admin', email: 'admin@example.test', isActive: true };
const now = () => Math.floor(Date.now() / 1000);

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { status: jest.Mock; json: jest.Mock };
}

function authed(session: AuthenticatedRequest['session'], extra: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return { user: { ...USER } as any, humanJwt: true, session, ...extra } as AuthenticatedRequest;
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.MFA_STEP_UP_MAX_AGE_SEC;
  getDb.mockResolvedValue({
    getRepository: () => ({ findOne: jest.fn(async ({ where }: any) => (where.id === USER.id ? USER : null)) }),
  });
});

describe('hasRecentMfa', () => {
  it('is true only for a human session with a recent second factor', () => {
    expect(hasRecentMfa(authed({ amr: ['pwd', 'otp', 'mfa'], authTime: now() - 60, mfaEnroll: false }) as Request)).toBe(true);
    expect(hasRecentMfa(authed({ amr: ['pwd'], authTime: now(), mfaEnroll: false }) as Request)).toBe(false);
    expect(hasRecentMfa(authed({ amr: ['mfa'], authTime: now() - 901, mfaEnroll: false }) as Request)).toBe(false);
    expect(hasRecentMfa(authed({ amr: ['mfa'], authTime: now() - 120, mfaEnroll: false }) as Request, 60)).toBe(false);
  });

  it('is false for agent and SDK tokens (they never count as a step-up)', () => {
    const agent = { agentToken: { id: 't', name: 'mcp', scopes: ['*'], tokenPrefix: 'plat_agent_x' } } as AuthenticatedRequest;
    expect(hasRecentMfa(agent as Request)).toBe(false);
    const sdk = authed({ amr: ['mfa'], authTime: now(), mfaEnroll: false }, { sdkToken: true });
    expect(hasRecentMfa(sdk as Request)).toBe(false);
  });
});

describe('requireRecentMfa', () => {
  it('passes a session whose second factor is recent', () => {
    const next = jest.fn();
    const res = mockRes();
    requireRecentMfa()(authed({ amr: ['pwd', 'otp', 'mfa'], authTime: now() - 60, mfaEnroll: false }) as Request, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['no second factor', { amr: ['pwd'], authTime: now(), mfaEnroll: false }],
    ['second factor too old', { amr: ['pwd', 'otp', 'mfa'], authTime: now() - 901, mfaEnroll: false }],
    ['pre-MFA session without auth_time', { amr: [], authTime: null, mfaEnroll: false }],
    ['auth_time in the future', { amr: ['mfa'], authTime: now() + 3600, mfaEnroll: false }],
  ])('answers 401 step_up_required: %s', (_label, session) => {
    const next = jest.fn();
    const res = mockRes();
    requireRecentMfa()(authed(session as any) as Request, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'step_up_required', maxAgeSec: 900 }));
  });

  it('honours an explicit max age and MFA_STEP_UP_MAX_AGE_SEC', () => {
    const session = { amr: ['mfa'], authTime: now() - 120, mfaEnroll: false };
    const next = jest.fn();
    requireRecentMfa(60)(authed(session) as Request, mockRes(), next);
    expect(next).not.toHaveBeenCalled();
    process.env.MFA_STEP_UP_MAX_AGE_SEC = '300';
    expect(stepUpMaxAgeSec()).toBe(300);
    requireRecentMfa()(authed(session) as Request, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('lets agent tokens through (governed by scopes + human approval, not MFA)', () => {
    const next = jest.fn();
    const req = { agentToken: { id: 't', name: 'mcp', scopes: ['*'], tokenPrefix: 'plat_agent_x' } } as AuthenticatedRequest;
    requireRecentMfa()(req as Request, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects unauthenticated requests', () => {
    const res = mockRes();
    requireRecentMfa()({} as Request, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('expressAuthenticate session claims', () => {
  function run(token: string, method = 'GET', url = '/api/projects') {
    const req: any = { headers: { authorization: `Bearer ${token}` }, method, originalUrl: url, url };
    const res = mockRes();
    const next: NextFunction = jest.fn();
    return expressAuthenticate(req, res, next).then(() => ({ req: req as AuthenticatedRequest, res, next }));
  }

  it('exposes amr and auth_time of the session', async () => {
    const token = signSessionToken(USER, { amr: ['pwd', 'otp', 'mfa'], authTime: 1_800_000_000 });
    const { req, next } = await run(token);
    expect(next).toHaveBeenCalled();
    expect(req.session).toEqual({ amr: ['pwd', 'otp', 'mfa'], authTime: 1_800_000_000, mfaEnroll: false });
  });

  it('keeps accepting sessions issued before MFA support (no amr)', async () => {
    const legacy = jwt.sign({ id: USER.id, email: USER.email, name: USER.name, role: USER.role }, JWT_SECRET);
    const { req, next } = await run(legacy);
    expect(next).toHaveBeenCalled();
    expect(req.session).toEqual({ amr: [], authTime: null, mfaEnroll: false });
  });

  it('never accepts an MFA challenge token as a session', async () => {
    const { res, next } = await run(signMfaChallenge(USER.id, ['pwd']));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('refuses tokens without a user id (no lookup with an undefined id)', async () => {
    const { res, next } = await run(jwt.sign({ sub: USER.id }, JWT_SECRET));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('restricts an enrolment-only session to the enrolment endpoints', async () => {
    const token = signSessionToken(USER, { amr: ['pwd'], mfaEnroll: true });
    const blocked = await run(token, 'GET', '/api/projects');
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(403);
    expect(blocked.res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'mfa_enrollment_required' }));
    for (const [method, url] of [['POST', '/api/auth/mfa/enroll'], ['POST', '/api/auth/mfa/verify'], ['GET', '/api/auth/mfa/status'], ['GET', '/api/users/me']]) {
      const ok = await run(token, method, url);
      expect(ok.next).toHaveBeenCalled();
      expect(ok.req.session?.mfaEnroll).toBe(true);
    }
    const patchMe = await run(token, 'PATCH', '/api/users/me');
    expect(patchMe.next).not.toHaveBeenCalled();
  });

  it('allowedDuringEnrollment ignores query strings and trailing slashes', () => {
    expect(allowedDuringEnrollment('POST', '/api/auth/mfa/verify?x=1')).toBe(true);
    expect(allowedDuringEnrollment('GET', '/api/users/me/')).toBe(true);
    expect(allowedDuringEnrollment('POST', '/api/auth/mfa/challenge')).toBe(false);
    expect(allowedDuringEnrollment('POST', '/api/auth/mfa/step-up')).toBe(false);
    expect(allowedDuringEnrollment('GET', '/api/users/me/../projects')).toBe(false);
  });
});
