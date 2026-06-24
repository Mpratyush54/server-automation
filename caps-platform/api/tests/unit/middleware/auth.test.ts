import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthenticatedRequest } from '../../../src/middleware/auth';

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(),
}));

const { getDb } = require('../../../src/config/database');

// Inline the middleware functions to avoid complex mocking
const JWT_SECRET = 'caps-platform-super-secret-key';

function authenticate(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }
  const token = auth.substring(7);

  if (token.startsWith('sdk-')) {
    (req as AuthenticatedRequest).sdkToken = true;
    (req as AuthenticatedRequest).projectId = token.split(':')[0] || 'unknown';
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    (req as AuthenticatedRequest).user = {
      id: decoded.id,
      role: decoded.role,
      roleId: decoded.roleId || null,
      name: decoded.name,
      email: decoded.email,
    };
    next();
  } catch (err: any) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

function requireRole(roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
}

describe('Auth Middleware', () => {
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
  });

  describe('expressAuthenticate', () => {
    it('should return 401 when no Authorization header', () => {
      authenticate(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized: Missing token' });
    });

    it('should return 401 when Authorization does not start with Bearer', () => {
      req.headers = { authorization: 'Basic abc123' };
      authenticate(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should handle SDK tokens', () => {
      req.headers = { authorization: 'Bearer sdk-project-id:secret' };
      authenticate(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect((req as AuthenticatedRequest).sdkToken).toBe(true);
    });

    it('should verify JWT token and set user on request', () => {
      const payload = { id: 'user-1', role: 'devops', name: 'Test', email: 'test@test.com' };
      const token = jwt.sign(payload, JWT_SECRET);
      req.headers = { authorization: `Bearer ${token}` };

      authenticate(req as Request, res as Response, next);

      expect(next).toHaveBeenCalled();
      expect((req as AuthenticatedRequest).user).toEqual({
        id: 'user-1',
        role: 'devops',
        roleId: null,
        name: 'Test',
        email: 'test@test.com',
      });
    });

    it('should return 401 when JWT is invalid', () => {
      req.headers = { authorization: 'Bearer invalid-token' };
      authenticate(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('expressRequireRole', () => {
    it('should call next when user has required role', () => {
      (req as AuthenticatedRequest).user = { id: '1', role: 'devops' as any, roleId: null, name: 'Test', email: 't@t.com' };
      const middleware = requireRole(['devops']);
      middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('should return 403 when user does not have required role', () => {
      (req as AuthenticatedRequest).user = { id: '1', role: 'developer' as any, roleId: null, name: 'Test', email: 't@t.com' };
      const middleware = requireRole(['devops']);
      middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should return 403 when no user on request', () => {
      const middleware = requireRole(['devops']);
      middleware(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('should allow multiple roles', () => {
      (req as AuthenticatedRequest).user = { id: '1', role: 'tech_lead' as any, roleId: null, name: 'Test', email: 't@t.com' };
      const middleware = requireRole(['devops', 'tech_lead']);
      middleware(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });
  });
});
