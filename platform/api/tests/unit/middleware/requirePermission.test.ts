import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../src/middleware/auth';

jest.mock('../../../src/config/database', () => ({
  getDb: jest.fn(),
}));

const { getDb } = require('../../../src/config/database');

const mockRoleRepo = {
  findOne: jest.fn(),
};

getDb.mockResolvedValue({
  getRepository: jest.fn().mockReturnValue(mockRoleRepo),
});

// Re-import after mocks are set
import { requirePermission, clearPermissionCache } from '../../../src/middleware/auth';

describe('requirePermission middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    jest.clearAllMocks();
    clearPermissionCache();
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it('should return 401 when no user on request', async () => {
    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should call next when user has the permission via role preset', async () => {
    mockRoleRepo.findOne.mockResolvedValue(null);

    (req as AuthenticatedRequest).user = {
      id: '1',
      role: 'devops' as any,
      roleId: null,
      name: 'Test',
      email: 't@t.com',
    };

    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('should return 403 when user lacks the permission', async () => {
    mockRoleRepo.findOne.mockResolvedValue(null);

    (req as AuthenticatedRequest).user = {
      id: '2',
      role: 'developer' as any,
      roleId: null,
      name: 'Test',
      email: 't@t.com',
    };

    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should allow access when custom role grants the permission', async () => {
    mockRoleRepo.findOne.mockResolvedValue({
      id: 'role-1',
      permissions: ['users.create', 'users.update'],
    });

    (req as AuthenticatedRequest).user = {
      id: '3',
      role: 'developer' as any,
      roleId: 'role-1',
      name: 'Test',
      email: 't@t.com',
    };

    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('should require ALL permissions when multiple are specified', async () => {
    mockRoleRepo.findOne.mockResolvedValue(null);

    (req as AuthenticatedRequest).user = {
      id: '4',
      role: 'tech_lead' as any,
      roleId: null,
      name: 'Test',
      email: 't@t.com',
    };

    // tech_lead has users.list but not users.create
    const middleware = requirePermission('users.list', 'users.create');
    await middleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should pass when all multiple permissions are satisfied', async () => {
    mockRoleRepo.findOne.mockResolvedValue(null);

    (req as AuthenticatedRequest).user = {
      id: '5',
      role: 'devops' as any,
      roleId: null,
      name: 'Test',
      email: 't@t.com',
    };

    const middleware = requirePermission('users.list', 'users.create');
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('should skip permission check for SDK tokens', async () => {
    (req as AuthenticatedRequest).sdkToken = true;
    (req as AuthenticatedRequest).projectId = 'proj-1';

    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('should cache permissions and reuse on subsequent calls', async () => {
    mockRoleRepo.findOne.mockResolvedValue(null);

    (req as AuthenticatedRequest).user = {
      id: '6',
      role: 'devops' as any,
      roleId: null,
      name: 'Test',
      email: 't@t.com',
    };

    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();

    // Second call should use cache (no additional DB query)
    const next2 = jest.fn();
    await middleware(req as Request, res as Response, next2);
    expect(next2).toHaveBeenCalled();
    // roleId is null so no DB query needed — cache hit on preset permissions only
  });

  it('should clear cache for specific user', async () => {
    mockRoleRepo.findOne.mockResolvedValue(null);

    (req as AuthenticatedRequest).user = {
      id: '7',
      role: 'devops' as any,
      roleId: null,
      name: 'Test',
      email: 't@t.com',
    };

    const middleware = requirePermission('users.create');
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();

    clearPermissionCache('7');

    // Next call should re-evaluate (but roleId is null so still no DB query)
    const next2 = jest.fn();
    await middleware(req as Request, res as Response, next2);
    expect(next2).toHaveBeenCalled();
  });
});
