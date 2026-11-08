import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { Role } from '../entities/Role';
import { expressAuthenticate, expressRequireRole, requirePermission, logAudit, clearPermissionCache, getUserPermissions, AuthenticatedRequest } from '../middleware/auth';
import { Permission } from '../config/permissions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import bcrypt from 'bcryptjs';
import { ensureAdminUser } from '../lib/seed-admin';
import { resolveIntegrations, publicAuthProviders } from '../lib/integrations';
import { buildAuthorizeUrl, completeOAuthCallback, loginFailedRedirect } from '../lib/oauth-login';

const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';
const router = Router();

router.get('/health', (req: Request, res: Response) => {
  return res.json({ status: 'ok' });
});

/**
 * POST /api/auth/login
 * Requires email (or username) + password. Passwordless login is not supported.
 */
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, username, password } = req.body;
    if (!password || typeof password !== 'string') {
      return res.status(401).json({ error: 'Password is required.' });
    }

    const ident = [username, email]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0) || '';
    if (!ident) {
      return res.status(401).json({ error: 'Email or username is required.' });
    }

    const ds = await getDb();
    const repo = ds.getRepository(User);

    let user: User | null = await repo.findOne({ where: { email: ident } });
    if (!user) {
      user = await repo.findOne({ where: { username: ident } });
    }
    const identLower = ident.toLowerCase();
    if (!user && identLower !== ident) {
      user = await repo.findOne({ where: { email: identLower } });
    }
    if (!user && identLower !== ident) {
      user = await repo.findOne({ where: { username: identLower } });
    }

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ error: 'Account is inactive. Contact an administrator.' });
    }

    user.lastLogin = new Date();
    await repo.save(user);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    const { passwordHash: _, ...safeUser } = user as any;
    return res.json({ token, user: safeUser });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/auth/providers', async (_req: Request, res: Response) => {
  try {
    const cfg = await resolveIntegrations();
    return res.json(publicAuthProviders(cfg));
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to load auth providers' });
  }
});

router.get('/auth/github', async (req: Request, res: Response) => {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const built = await buildAuthorizeUrl('github', req.get('host') || undefined, proto);
  if (built.ok) return res.redirect(built.url);
  return res.status(built.status).json({ error: built.error });
});

router.get('/auth/github/callback', async (req: Request, res: Response) => {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  try {
    const result = await completeOAuthCallback({
      provider: 'github',
      code: typeof req.query.code === 'string' ? req.query.code : undefined,
      state: typeof req.query.state === 'string' ? req.query.state : undefined,
      reqHost: req.get('host') || undefined,
      proto,
    });
    return res.redirect(result.redirect);
  } catch (err: any) {
    return res.redirect(loginFailedRedirect(req.get('host') || undefined, proto, err.message || 'GitHub login failed'));
  }
});

router.get('/auth/gitlab', async (req: Request, res: Response) => {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const built = await buildAuthorizeUrl('gitlab', req.get('host') || undefined, proto);
  if (built.ok) return res.redirect(built.url);
  return res.status(built.status).json({ error: built.error });
});

router.get('/auth/gitlab/callback', async (req: Request, res: Response) => {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  try {
    const result = await completeOAuthCallback({
      provider: 'gitlab',
      code: typeof req.query.code === 'string' ? req.query.code : undefined,
      state: typeof req.query.state === 'string' ? req.query.state : undefined,
      reqHost: req.get('host') || undefined,
      proto,
    });
    return res.redirect(result.redirect);
  } catch (err: any) {
    return res.redirect(loginFailedRedirect(req.get('host') || undefined, proto, err.message || 'GitLab login failed'));
  }
});

router.get('/users/init-demo', async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const { user, created, removedDemo } = await ensureAdminUser(repo);
    const { passwordHash: _, ...safe } = user as any;
    return res.json({
      message: created
        ? `Created admin ${user.email}`
        : `Admin ${user.email} already exists`,
      removedDemo,
      users: [{ ...safe, hasPassword: !!user.passwordHash }],
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/set-password
 * Allows an authenticated user to set or change their password.
 * Body: { currentPassword?: string, newPassword: string }
 */
router.post('/auth/set-password', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: (req as AuthenticatedRequest).user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // If user already has a password, require the current one
    if (user.passwordHash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required to set a new one.' });
      }
      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await repo.save(user);

    return res.json({ success: true, message: 'Password updated successfully.' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find({
      order: { createdAt: 'DESC' as any },
    });
    // Never return password hashes to the client
    return res.json(users.map((u) => {
      const { passwordHash, ...safe } = u as any;
      return { ...safe, hasPassword: !!passwordHash };
    }));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/users', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(User);

    if (!body.name || !body.email) {
      return res.status(400).json({ error: 'name and email are required' });
    }
    if (!body.password || String(body.password).length < 8) {
      return res.status(400).json({ error: 'password is required (min 8 characters) so the user can log in' });
    }
    const allowedRoles = Object.values(UserRole);
    const role = (body.role as UserRole) || UserRole.DEVELOPER;
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${allowedRoles.join(', ')}` });
    }

    const existingByEmail = await repo.findOne({ where: { email: body.email } });
    if (existingByEmail) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    const username = body.username || body.email.split('@')[0];
    const existingByUser = await repo.findOne({ where: { username } });
    if (existingByUser) {
      return res.status(409).json({ error: 'A user with that username already exists' });
    }

    const passwordHash = await bcrypt.hash(String(body.password), 10);
    const user = repo.create({
      id: uuidv4(),
      name: body.name,
      email: body.email,
      username,
      passwordHash,
      role,
      gitlabId: body.gitlabId || null,
      githubId: body.githubId || null,
      avatarUrl: body.avatarUrl || null,
      isActive: body.isActive !== false,
    });
    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.created',
      targetType: 'User',
      targetId: saved.id,
      ip: req.ip,
    });

    const { passwordHash: _, ...safe } = saved as any;
    return res.status(201).json({ ...safe, hasPassword: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/users/:id', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (body.name !== undefined) user.name = body.name;
    if (body.email !== undefined) user.email = body.email;
    if (body.username !== undefined) user.username = body.username;
    if (body.role !== undefined) {
      if (!Object.values(UserRole).includes(body.role)) {
        return res.status(400).json({ error: `Invalid role. Allowed: ${Object.values(UserRole).join(', ')}` });
      }
      user.role = body.role as UserRole;
    }
    if (body.gitlabId !== undefined) user.gitlabId = body.gitlabId;
    if (body.githubId !== undefined) user.githubId = body.githubId;
    if (body.avatarUrl !== undefined) user.avatarUrl = body.avatarUrl;
    if (body.isActive !== undefined) user.isActive = !!body.isActive;
    if (body.password) {
      if (String(body.password).length < 8) {
        return res.status(400).json({ error: 'password must be at least 8 characters' });
      }
      user.passwordHash = await bcrypt.hash(String(body.password), 10);
    }

    const saved = await repo.save(user);
    clearPermissionCache(saved.id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.updated',
      targetType: 'User',
      targetId: saved.id,
      ip: req.ip,
    });

    const { passwordHash: _, ...safe } = saved as any;
    return res.json({ ...safe, hasPassword: !!saved.passwordHash });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/users/:id', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Prevent deleting yourself
    if ((req as AuthenticatedRequest).user?.id === user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    await repo.remove(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.deleted',
      targetType: 'User',
      targetId: req.params.id,
      ip: req.ip,
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users/me', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken) {
      return res.status(400).json({
        error: 'Agent tokens should use GET /api/agent-tokens/me instead of /api/users/me',
      });
    }
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({
      where: { id: authReq.user!.id },
      relations: ['roleRef'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { passwordHash: _, ...safe } = user as any;
    return res.json({ ...safe, hasPassword: !!user.passwordHash });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/users/me', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: (req as AuthenticatedRequest).user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, avatarUrl } = req.body;
    if (name !== undefined) user.name = name;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

    const saved = await repo.save(user);
    const { passwordHash: _, ...safe } = saved as any;
    return res.json({ ...safe, hasPassword: !!saved.passwordHash });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/users/invite', expressAuthenticate, requirePermission('users.create'), async (req: Request, res: Response) => {
  try {
    const { email, name, roleId, role, password, username } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }
    if (!password || String(password).length < 8) {
      return res.status(400).json({ error: 'password is required (min 8 characters) so the user can log in' });
    }

    const ds = await getDb();
    const repo = ds.getRepository(User);

    const emailNorm = String(email).trim();
    const existing = await repo.findOne({ where: { email: emailNorm } });
    if (existing) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const uname = (username && String(username).trim()) || emailNorm.split('@')[0];
    const existingByUser = await repo.findOne({ where: { username: uname } });
    if (existingByUser) {
      return res.status(409).json({ error: 'A user with that username already exists' });
    }

    const userRole = (role as UserRole) || UserRole.DEVELOPER;
    const passwordHash = await bcrypt.hash(String(password), 10);

    const user = repo.create({
      id: uuidv4(),
      name,
      email: emailNorm,
      username: uname,
      passwordHash,
      role: userRole,
      roleId: roleId || null,
    });
    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.invited',
      targetType: 'User',
      targetId: saved.id,
      metadata: { email: emailNorm, role: userRole, roleId },
      ip: req.ip,
    });

    const { passwordHash: _, ...safe } = saved as any;
    return res.status(201).json({ ...safe, hasPassword: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/users/:id/role', expressAuthenticate, requirePermission('users.assign-role'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, roleId } = req.body;

    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (role !== undefined) user.role = role as UserRole;
    if (roleId !== undefined) user.roleId = roleId || null;

    const saved = await repo.save(user);
    clearPermissionCache(id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.role-updated',
      targetType: 'User',
      targetId: id,
      metadata: { role: user.role, roleId: user.roleId },
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users/:id/permissions', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({
      where: { id: req.params.id },
      relations: ['roleRef'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const perms = await getUserPermissions({ id: user.id, role: user.role, roleId: user.roleId });
    return res.json({
      userId: user.id,
      role: user.role,
      roleId: user.roleId,
      permissions: Array.from(perms),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/roles', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const roles = await ds.getRepository(Role).find({ order: { name: 'ASC' } });
    return res.json(roles);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/roles/:id', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const role = await ds.getRepository(Role).findOne({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    return res.json(role);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/roles', expressAuthenticate, requirePermission('users.create'), async (req: Request, res: Response) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Role name is required' });

    const ds = await getDb();
    const repo = ds.getRepository(Role);

    const existing = await repo.findOne({ where: { name } });
    if (existing) return res.status(409).json({ error: 'Role with this name already exists' });

    const role = repo.create({
      name,
      description: description || null,
      permissions: permissions || [],
    });
    const saved = await repo.save(role);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.created',
      targetType: 'Role',
      targetId: saved.id,
      metadata: { name, permissionsCount: (permissions || []).length },
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/roles/:id', expressAuthenticate, requirePermission('users.update'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ds = await getDb();
    const repo = ds.getRepository(Role);
    const role = await repo.findOne({ where: { id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res.status(400).json({ error: 'Cannot modify system roles' });
    }

    const { name, description, permissions, isActive } = req.body;
    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions !== undefined) role.permissions = permissions;
    if (isActive !== undefined) role.isActive = isActive;

    const saved = await repo.save(role);

    // Clear permission cache for all users with this role
    const users = await ds.getRepository(User).find({ where: { roleId: id } });
    for (const u of users) clearPermissionCache(u.id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.updated',
      targetType: 'Role',
      targetId: id,
      metadata: { name: role.name },
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/roles/:id', expressAuthenticate, requirePermission('users.delete'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ds = await getDb();
    const repo = ds.getRepository(Role);
    const role = await repo.findOne({ where: { id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res.status(400).json({ error: 'Cannot delete system roles' });
    }

    // Unassign users from this role
    const users = await ds.getRepository(User).find({ where: { roleId: id } });
    for (const u of users) {
      u.roleId = null;
      await ds.getRepository(User).save(u);
      clearPermissionCache(u.id);
    }

    await repo.remove(role);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: id,
      metadata: { name: role.name, affectedUsers: users.length },
      ip: req.ip,
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/permissions', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  const { PERMISSIONS } = require('../config/permissions');
  return res.json(PERMISSIONS);
});

router.post('/roles/:id/permissions/validate', expressAuthenticate, requirePermission('users.update'), async (req: Request, res: Response) => {
  try {
    const { permissions } = req.body;
    const { PERMISSIONS: ALL_PERMS } = require('../config/permissions');
    const valid = (permissions || []).filter((p: string) => p in ALL_PERMS);
    const invalid = (permissions || []).filter((p: string) => !(p in ALL_PERMS));
    return res.json({ valid, invalid, totalValid: valid.length, totalInvalid: invalid.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
