import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { Role } from '../entities/Role';
import { AuditLog } from '../entities/AuditLog';
import { AgentToken } from '../entities/AgentToken';
import { Permission, ROLE_PRESETS } from '../config/permissions';

const JWT_SECRET = process.env.JWT_SECRET || 'plat-super-secret-key';
const PERMISSION_CACHE_TTL_MS = 60_000;
export const AGENT_TOKEN_PREFIX = 'plat_agent_';
/** Characters of the raw token used for DB lookup (includes plat_agent_). */
export const AGENT_TOKEN_LOOKUP_LEN = 20;

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
  agentToken?: {
    id: string;
    name: string;
    scopes: string[];
    tokenPrefix: string;
  };
  /** True when authenticated via human JWT (not agent token / SDK). */
  humanJwt?: boolean;
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

async function authenticateAgentToken(rawToken: string, req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const prefix = rawToken.slice(0, AGENT_TOKEN_LOOKUP_LEN);
  if (prefix.length < AGENT_TOKEN_LOOKUP_LEN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid agent token' });
  }

  try {
    const ds = await getDb();
    const repo = ds.getRepository(AgentToken);
    const record = await repo.findOne({ where: { tokenPrefix: prefix } });
    if (!record || !record.isActive || record.revokedAt) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or revoked agent token' });
    }
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) {
      return res.status(401).json({ error: 'Unauthorized: Agent token expired' });
    }

    const valid = await bcrypt.compare(rawToken, record.tokenHash);
    if (!valid) {
      return res.status(401).json({ error: 'Unauthorized: Invalid agent token' });
    }

    record.lastUsedAt = new Date();
    await repo.save(record).catch(() => {});

    req.agentToken = {
      id: record.id,
      name: record.name,
      scopes: Array.isArray(record.scopes) ? record.scopes : [],
      tokenPrefix: record.tokenPrefix,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized: Could not validate agent token' });
  }
}

export async function expressAuthenticate(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }
  const token = auth.substring(7);

  if (token.startsWith(AGENT_TOKEN_PREFIX)) {
    return authenticateAgentToken(token, req as AuthenticatedRequest, res, next);
  }

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
    if (user.isActive === false) {
      return res.status(403).json({ error: 'Account is inactive. Contact an administrator.' });
    }

    (req as AuthenticatedRequest).user = {
      id: user.id,
      role: user.role,
      roleId: user.roleId,
      name: user.name,
      email: user.email,
    };
    (req as AuthenticatedRequest).humanJwt = true;
    next();
  } catch (err: any) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
}

export function expressRequireRole(roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken) {
      return res.status(403).json({ error: 'Forbidden: Agent tokens cannot use role-gated human endpoints' });
    }
    const user = authReq.user;
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Not authenticated' });
    }
    if (user.role === UserRole.ADMIN || roles.includes(user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
  };
}

/**
 * Allow either a human JWT with one of the roles, or an agent token with ANY of the listed scopes.
 * Used for MCP-facing read endpoints (pods, audit logs, etc.).
 */
export function requireAgentScopeOrRole(scopes: string[], roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken) {
      const agent = authReq.agentToken;
      const ok = agent.scopes.includes('*') || scopes.some((s) => agent.scopes.includes(s));
      if (!ok) {
        return res.status(403).json({
          error: 'Forbidden: Agent token missing required scopes',
          requiredAnyOf: scopes,
        });
      }
      return next();
    }
    return expressRequireRole(roles)(req, res, next);
  };
}

export function requirePermission(...permissions: Permission[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    // SDK tokens bypass permission checks (they use separate auth)
    if (authReq.sdkToken) return next();

    // Agent tokens use scope checks instead of RBAC permissions
    if (authReq.agentToken) {
      return res.status(403).json({
        error: 'Forbidden: Agent tokens cannot use permission-gated human endpoints',
        required: permissions,
      });
    }

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

/** Require an agent token that includes all listed scopes. Human JWTs bypass scope checks. */
export function requireAgentScope(...scopes: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    if (authReq.humanJwt && authReq.user) {
      return next();
    }

    const agent = authReq.agentToken;
    if (!agent) {
      return res.status(401).json({ error: 'Unauthorized: Agent token or human JWT required' });
    }

    const missing = scopes.filter((s) => !agent.scopes.includes(s) && !agent.scopes.includes('*'));
    if (missing.length > 0) {
      return res.status(403).json({
        error: 'Forbidden: Agent token missing required scopes',
        required: scopes,
        missing,
      });
    }
    return next();
  };
}

/** Require a human JWT — agent tokens are explicitly rejected. */
export function requireHumanJwt(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  if (authReq.agentToken) {
    return res.status(403).json({
      error: 'Forbidden: This action requires a human JWT from password login. Agent tokens cannot approve or list pending commands.',
    });
  }
  if (!authReq.user || !authReq.humanJwt) {
    return res.status(401).json({ error: 'Unauthorized: Human JWT required' });
  }
  return next();
}

export async function logAudit(params: { userId?: string; action: string; targetType?: string; targetId?: string; metadata?: any; ip?: string }) {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(AuditLog);
    await repo.save(repo.create({
      userId: params.userId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: params.metadata,
      ipAddress: params.ip,
    }));
  } catch {}
}

export async function sdkTokenAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing SDK token' });
  }

  const token = auth.substring(7);

  // Accept both formats: "sdk-{projectId}:{secret}" and raw "sdk_live_{uuid}"
  let projectId: string | null = null;

  if (token.startsWith('sdk-')) {
    // Format: sdk-{projectId}:{secret}
    const parts = token.split(':');
    projectId = parts[0]?.replace('sdk-', '') || null;
  } else if (token.startsWith('sdk_live_') || token.startsWith('sdk_test_')) {
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
