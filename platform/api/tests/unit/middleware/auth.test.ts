import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(),
}));

const { getDb } = require('../../../src/config/database');

import {
  AuthenticatedRequest,
  expressAuthenticate,
  expressRequireRole,
  sdkTokenAuth,
  sdkOrUserAuthenticate,
  sdkProjectMatches,
} from '../../../src/middleware/auth';
import { UserRole } from '../../../src/entities/User';

const JWT_SECRET = 'unit-test-jwt-secret-0123456789abcdef';
const PROJECT_ID = '11111111-2222-3333-4444-555555555555';
const SDK_TOKEN = 'sdk_live_0123456789abcdef0123456789abcdef';

const users: Record<string, any> = {
  'user-1': { id: 'user-1', role: 'devops', roleId: null, name: 'Test', email: 'test@test.com', isActive: true },
};
const credentials: any[] = [{ id: 'c1', token: SDK_TOKEN, projectId: PROJECT_ID, status: 'active' }];
const projects: Record<string, any> = { [PROJECT_ID]: { id: PROJECT_ID, name: 'demo' } };

function repoFor(entity: any) {
  const name = typeof entity === 'string' ? entity : entity?.name;
  if (name === 'User') return { findOne: jest.fn(async ({ where }: any) => users[where.id] || null) };
  if (name === 'SdkCredential') {
    return {
      findOne: jest.fn(async ({ where }: any) =>
        credentials.find((c) => c.token === where.token && c.status === where.status) || null),
    };
  }
  if (name === 'Project') return { findOne: jest.fn(async ({ where }: any) => projects[where.id] || null) };
  return { findOne: jest.fn().mockResolvedValue(null) };
}

describe('Auth Middleware (real implementation)', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    process.env.JWT_SECRET = JWT_SECRET;
    getDb.mockResolvedValue({ getRepository: jest.fn(repoFor) });
  });

  describe('expressAuthenticate', () => {
    it('returns 401 when no Authorization header', async () => {
      await expressAuthenticate(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Missing token' });
    });

    it('returns 401 when Authorization does not start with Bearer', async () => {
      req.headers = { authorization: 'Basic abc123' };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    // C1 regression: any "sdk-" prefixed string used to authenticate without verification.
    it('rejects unverified "sdk-{id}:{secret}" bearer strings', async () => {
      req.headers = { authorization: 'Bearer sdk-project-id:secret' };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect((req as AuthenticatedRequest).sdkToken).toBeUndefined();
    });

    it('does not accept even a valid stored SDK credential on human endpoints', async () => {
      req.headers = { authorization: `Bearer ${SDK_TOKEN}` };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('verifies a JWT and loads the user from the DB', async () => {
      const token = jwt.sign({ id: 'user-1', role: 'admin' }, JWT_SECRET);
      req.headers = { authorization: `Bearer ${token}` };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      // role comes from the DB row, not the token claims
      expect((req as AuthenticatedRequest).user).toEqual({
        id: 'user-1', role: 'devops', roleId: null, name: 'Test', email: 'test@test.com',
      });
      expect((req as AuthenticatedRequest).humanJwt).toBe(true);
    });

    it('rejects a JWT signed with the old published default secret', async () => {
      const token = jwt.sign({ id: 'user-1' }, 'plat-super-secret-key');
      req.headers = { authorization: `Bearer ${token}` };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when JWT is invalid', async () => {
      req.headers = { authorization: 'Bearer invalid-token' };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('returns 401 when JWT_SECRET is not configured', async () => {
      const token = jwt.sign({ id: 'user-1' }, JWT_SECRET);
      delete process.env.JWT_SECRET;
      req.headers = { authorization: `Bearer ${token}` };
      await expressAuthenticate(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('sdkTokenAuth (C2)', () => {
    it('rejects the legacy unverified sdk-{projectId}:{secret} format', async () => {
      req.headers = { authorization: `Bearer sdk-${PROJECT_ID}:anything` };
      await sdkTokenAuth(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('rejects unknown sdk_live_ tokens', async () => {
      req.headers = { authorization: 'Bearer sdk_live_doesnotexist000000000000' };
      await sdkTokenAuth(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('accepts a stored active credential and binds the request to its project', async () => {
      req.headers = { authorization: `Bearer ${SDK_TOKEN}` };
      await sdkTokenAuth(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      const a = req as AuthenticatedRequest;
      expect(a.sdkToken).toBe(true);
      expect(a.projectId).toBe(PROJECT_ID);
      expect(a.sdkProjectName).toBe('demo');
    });

    it('sdkOrUserAuthenticate routes sdk_live_ to sdkTokenAuth and others to JWT', async () => {
      req.headers = { authorization: `Bearer ${SDK_TOKEN}` };
      await sdkOrUserAuthenticate(req as Request, res as Response, next);
      expect((req as AuthenticatedRequest).sdkToken).toBe(true);

      const req2: Partial<Request> = { headers: { authorization: 'Bearer sdk-x:y' } };
      const next2 = jest.fn();
      await sdkOrUserAuthenticate(req2 as Request, res as Response, next2);
      expect(next2).not.toHaveBeenCalled();
    });

    it('sdkProjectMatches only accepts the bound project (id or name)', () => {
      const a = { sdkToken: true, projectId: PROJECT_ID, sdkProjectName: 'demo' } as AuthenticatedRequest;
      expect(sdkProjectMatches(a, PROJECT_ID)).toBe(true);
      expect(sdkProjectMatches(a, 'demo')).toBe(true);
      expect(sdkProjectMatches(a, undefined)).toBe(true);
      expect(sdkProjectMatches(a, 'other')).toBe(false);
      expect(sdkProjectMatches(a, ['demo'])).toBe(false);
      expect(sdkProjectMatches({} as AuthenticatedRequest, PROJECT_ID)).toBe(false);
    });
  });

  describe('expressRequireRole', () => {
    it('calls next when user has required role', () => {
      (req as AuthenticatedRequest).user = { id: '1', role: UserRole.DEVOPS, roleId: null, name: 'Test', email: 't@t.com' };
      expressRequireRole([UserRole.DEVOPS])(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 403 when user does not have required role', () => {
      (req as AuthenticatedRequest).user = { id: '1', role: UserRole.DEVELOPER, roleId: null, name: 'Test', email: 't@t.com' };
      expressRequireRole([UserRole.DEVOPS])(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('returns 401 when no user on request', () => {
      expressRequireRole([UserRole.DEVOPS])(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});
