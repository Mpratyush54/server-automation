import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { Role } from '../entities/Role';
import { AuditLog } from '../entities/AuditLog';
import { Permission, ROLE_PRESETS } from '../config/permissions';

const JWT_SECRET = process.env.JWT_SECRET || 'caps-platform-super-secret-key';
const PERMISSION_CACHE_TTL_MS = 60_000;

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: UserRole;
    roleId: string | null;
    name: string;
    email: string;
  };
  sdkToken?: boolean;
  projectId?: string;
}

// Simple in-memory permission cache: userId → { permissions, expiresAt }
const permCache = new Map<string, { permissions: Set<string>; expiresAt: number }>();

export async function getUserPermissions(user: { id: string; role: UserRole; roleId: string | null }): Promise<Set<string>> {
  const cached = permCache.get(user.id);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.permissions;
  }

  const perms = new Set<string>();

  // Start with role preset permissions
  const preset = ROLE_PRESETS[user.role];
  if (preset) {
    for (const p of preset) perms.add(p);
  }

  // If user has a custom role, merge its permissions
  if (user.roleId) {
    try {
      const ds = await getDb();
      const role = await ds.getRepository(Role).findOne({ where: { id: user.roleId } });
      if (role && role.permissions) {
        for (const p of role.permissions) perms.add(p);
      }
    } catch {}
  }

  permCache.set(user.id, { permissions: perms, expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS });
  return perms;
}

export function clearPermissionCache(userId?: string) {
  if (userId) {
    permCache.delete(userId);
  } else {
    permCache.clear();
  }
}

export async function expressAuthenticate(req: Request, res: Response, next: NextFunction) {
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
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: decoded.id } });
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: User not found' });
    }

    (req as AuthenticatedRequest).user = {
      id: user.id,
      role: user.role,
      roleId: user.roleId,
      name: user.name,
      email: user.email,
    };
    next();
  } catch (err: any) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

export function expressRequireRole(roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
    }
    next();
  };
}

export function requirePermission(...permissions: Permission[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    // SDK tokens bypass permission checks (they use separate auth)
    if (authReq.sdkToken) return next();

    const user = authReq.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Not authenticated' });
    }

    try {
      const userPerms = await getUserPermissions(user);
      const hasAll = permissions.every((p) => userPerms.has(p));
      if (!hasAll) {
        return res.status(403).json({
          error: 'Forbidden: Insufficient permissions',
          required: permissions,
        });
      }
      next();
    } catch {
      return res.status(403).json({ error: 'Forbidden: Could not verify permissions' });
    }
  };
}

export async function logAudit(params: { userId?: string; action: string; targetType?: string; targetId?: string; metadata?: any; ip?: string }) {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(AuditLog);
    await repo.save(repo.create(params));
  } catch {}
}

export async function sdkTokenAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing SDK token' });
  }

  const token = auth.substring(7);

  // Accept both formats: "sdk-{projectId}:{secret}" and raw "caps_sdk_live_{uuid}"
  let projectId: string | null = null;

  if (token.startsWith('sdk-')) {
    // Format: sdk-{projectId}:{secret}
    const parts = token.split(':');
    projectId = parts[0]?.replace('sdk-', '') || null;
  } else if (token.startsWith('caps_sdk_live_') || token.startsWith('caps_sdk_test_')) {
    // Raw token — look up in SdkCredential table
    try {
      const ds = await getDb();
      const credential = await ds.getRepository('SdkCredential').findOne({ where: { token, status: 'active' } });
      if (!credential) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or revoked SDK token' });
      }
      projectId = credential.projectId;
    } catch {
      return res.status(401).json({ error: 'Unauthorized: Could not validate SDK token' });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorized: Invalid SDK token format' });
  }

  if (!projectId) {
    return res.status(401).json({ error: 'Unauthorized: Could not resolve project from SDK token' });
  }

  (req as AuthenticatedRequest).sdkToken = true;
  (req as AuthenticatedRequest).projectId = projectId;
  next();
}
