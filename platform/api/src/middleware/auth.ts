import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { getDb } from '../config/database';
import { User, UserRole } from '../entities/User';
import { Role } from '../entities/Role';
import { AuditLog } from '../entities/AuditLog';
import { AgentToken } from '../entities/AgentToken';
import { SdkCredential, SdkTokenKind, normalizeSdkTokenKind } from '../entities/SdkCredential';
import { Project } from '../entities/Project';
import { Permission, ROLE_PRESETS } from '../config/permissions';
import { getJwtSecret } from '../config/security-env';
import { PermissionInvalidationBus, permissionPubSubEnabled } from '../lib/perm-invalidation';

/** Only stored, revocable SDK credentials are accepted (see POST /projects/:id/tokens). */
export const SDK_TOKEN_PREFIXES = ['sdk_live_', 'sdk_test_'];
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
  /** True when authenticated via a stored SDK credential (sdkTokenAuth). */
  sdkToken?: boolean;
  /** Project UUID the SDK credential is bound to (set only by sdkTokenAuth). */
  projectId?: string;
  /** Project name the SDK credential is bound to (set only by sdkTokenAuth). */
  sdkProjectName?: string;
  /** Kind of the SDK credential (set only by sdkTokenAuth): `server` or `browser`. */
  sdkTokenKind?: SdkTokenKind;
  /** Set by allowBrowserSdkToken: this route accepts browser SDK tokens. */
  browserSdkTokenAllowed?: boolean;
  agentToken?: {
    id: string;
    name: string;
    scopes: string[];
    tokenPrefix: string;
  };
  /** True when authenticated via human JWT (not agent token / SDK). */
  humanJwt?: boolean;
  /** Session JWT authentication context (#24): methods, auth time, enrolment-only restriction. */
  session?: {
    amr: string[];
    /** Seconds since epoch; null for sessions issued before MFA support. */
    authTime: number | null;
    mfaEnroll: boolean;
  };
}

/** Default max age of the second factor for step-up protected actions (MFA_STEP_UP_MAX_AGE_SEC). */
export function stepUpMaxAgeSec(): number {
  const n = Number(process.env.MFA_STEP_UP_MAX_AGE_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 15 * 60;
}

/** Endpoints an enrolment-only session (`mfa_enroll`) may call. */
export function allowedDuringEnrollment(method: string, path: string): boolean {
  const p = path.split('?')[0].replace(/\/+$/, '');
  if (/\/auth\/mfa\/(status|enroll|verify)$/.test(p)) return true;
  return method === 'GET' && /\/users\/me$/.test(p);
}

// Short-lived per-process permission cache: userId → { permissions, expiresAt }. Not shared
// state: invalidations reach every replica over Redis pub/sub (lib/perm-invalidation.ts).
const permCache = new Map<string, { permissions: Set<string>; expiresAt: number }>();

function dropLocalPermissions(userId?: string) {
  if (userId) permCache.delete(userId);
  else permCache.clear();
}

export const permissionInvalidationBus = new PermissionInvalidationBus(dropLocalPermissions);

/**
 * Whether the local cache may be used. With Redis (multi-replica) only while the invalidation
 * subscription is live; otherwise fail open to the database so a missed invalidation can never
 * keep a revoked permission alive.
 */
function permissionCacheUsable(): boolean {
  if (!permissionPubSubEnabled()) return true;
  void permissionInvalidationBus.start();
  return permissionInvalidationBus.isReady();
}

export async function getUserPermissions(user: { id: string; role: UserRole; roleId: string | null }): Promise<Set<string>> {
  const useCache = permissionCacheUsable();
  const cached = useCache ? permCache.get(user.id) : undefined;
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

  if (useCache) permCache.set(user.id, { permissions: perms, expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS });
  return perms;
}

/** Invalidate locally and on every other replica (best-effort pub/sub; TTL bounds staleness). */
export function clearPermissionCache(userId?: string) {
  dropLocalPermissions(userId);
  if (permissionPubSubEnabled()) void permissionInvalidationBus.publish(userId);
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

  // SDK credentials are NOT accepted on human endpoints — they are only valid on
  // routes that explicitly use sdkTokenAuth / sdkOrUserAuthenticate.
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;
    // Only session tokens: MFA challenge tokens (typ/aud) and anything without a user id are refused.
    if (!decoded || typeof decoded !== 'object' || typeof decoded.id !== 'string' || !decoded.id || decoded.typ || decoded.aud) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }
    if (decoded.mfa_enroll === true && !allowedDuringEnrollment(req.method, req.originalUrl || req.url)) {
      return res.status(403).json({
        error: 'mfa_enrollment_required',
        message: 'Your role requires multi-factor authentication. Enrol an authenticator app to continue.',
      });
    }
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
    (req as AuthenticatedRequest).session = {
      amr: Array.isArray(decoded.amr) ? decoded.amr.filter((m: unknown) => typeof m === 'string') : [],
      authTime: typeof decoded.auth_time === 'number' ? decoded.auth_time : null,
      mfaEnroll: decoded.mfa_enroll === true,
    };
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

    // SDK credentials never satisfy RBAC permissions.
    if (authReq.sdkToken) {
      return res.status(403).json({
        error: 'Forbidden: SDK tokens cannot use permission-gated human endpoints',
        required: permissions,
      });
    }

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

/**
 * True when the request carries a human session whose second factor was confirmed within
 * `maxAgeSec` (default: stepUpMaxAgeSec()). Same rule as requireRecentMfa, for handlers that
 * degrade gracefully instead of failing. Agent/SDK tokens never count as a recent step-up.
 */
export function hasRecentMfa(req: Request, maxAgeSec?: number): boolean {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user || !authReq.humanJwt || authReq.agentToken || authReq.sdkToken) return false;
  const max = maxAgeSec ?? stepUpMaxAgeSec();
  const s = authReq.session;
  const now = Math.floor(Date.now() / 1000);
  return !!s && s.amr.includes('mfa') && typeof s.authTime === 'number'
    && s.authTime <= now + 60 && now - s.authTime <= max;
}

/**
 * Step-up (#24): a human session must carry a second factor (`amr` contains `mfa`) verified
 * within `maxAgeSec`, otherwise 401 `{ error: 'step_up_required' }` (POST /api/auth/mfa/step-up,
 * then retry). Agent tokens (plat_agent_*) and SDK credentials are non-interactive: they stay
 * governed by scopes and human approval and pass through unchanged.
 */
export function requireRecentMfa(maxAgeSec?: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken || authReq.sdkToken) return next();
    if (!authReq.user || !authReq.humanJwt) {
      return res.status(401).json({ error: 'Unauthorized: Not authenticated' });
    }
    const max = maxAgeSec ?? stepUpMaxAgeSec();
    if (hasRecentMfa(authReq, max)) return next();
    return res.status(401).json({
      error: 'step_up_required',
      maxAgeSec: max,
      message: 'Confirm with your authenticator app (POST /api/auth/mfa/step-up), then retry.',
    });
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

/**
 * Opt a route in to browser SDK tokens. Place it before sdkTokenAuth / sdkOrUserAuthenticate:
 *
 *   router.post('/sdk/bug-report', allowBrowserSdkToken, sdkTokenAuth, handler)
 *
 * Without it every SDK route is server-only: a `browser` token is answered with 403. Only add
 * it to write-only ingest endpoints that return no project config, secrets or credentials and
 * do not change deployments or service state, because a browser token ships in public JS.
 */
export function allowBrowserSdkToken(req: Request, _res: Response, next: NextFunction) {
  (req as AuthenticatedRequest).browserSdkTokenAllowed = true;
  next();
}

export async function sdkTokenAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing SDK token' });
  }

  const token = auth.substring(7).trim();

  // Only stored credentials ("sdk_live_…" / "sdk_test_…", issued via POST /projects/:id/tokens)
  // are accepted. The legacy "sdk-{projectId}:{secret}" format was never verified and is rejected.
  if (!SDK_TOKEN_PREFIXES.some((p) => token.startsWith(p)) || token.length < 20 || token.length > 255) {
    return res.status(401).json({ error: 'Unauthorized: Invalid SDK token format' });
  }

  let projectId: string;
  let projectName: string;
  let kind: SdkTokenKind;
  try {
    const ds = await getDb();
    const credential = await ds.getRepository(SdkCredential).findOne({ where: { token, status: 'active' } });
    if (!credential || credential.token !== token || credential.status !== 'active' || !credential.projectId) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or revoked SDK token' });
    }
    const project = await ds.getRepository(Project).findOne({ where: { id: credential.projectId } });
    if (!project || project.id !== credential.projectId) {
      return res.status(401).json({ error: 'Unauthorized: SDK token project no longer exists' });
    }
    projectId = project.id;
    projectName = project.name;
    kind = normalizeSdkTokenKind(credential.kind);
  } catch {
    return res.status(401).json({ error: 'Unauthorized: Could not validate SDK token' });
  }

  if (kind === 'browser' && !(req as AuthenticatedRequest).browserSdkTokenAllowed) {
    return res.status(403).json({
      error: 'Forbidden: browser SDK tokens cannot call this endpoint. Use a server SDK token from your backend.',
    });
  }

  (req as AuthenticatedRequest).sdkToken = true;
  (req as AuthenticatedRequest).sdkTokenKind = kind;
  (req as AuthenticatedRequest).projectId = projectId;
  (req as AuthenticatedRequest).sdkProjectName = projectName;
  next();
}

/** True when the bearer token looks like a stored SDK credential. */
export function isSdkBearer(req: Request): boolean {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.substring(7).trim();
  return SDK_TOKEN_PREFIXES.some((p) => token.startsWith(p));
}

/**
 * Accept either a stored SDK credential (bound to one project) or a normal
 * human JWT / agent token. Route handlers must still authorize the target project
 * (see sdkProjectMatches / requireProjectAccess).
 */
export function sdkOrUserAuthenticate(req: Request, res: Response, next: NextFunction) {
  if (isSdkBearer(req)) return sdkTokenAuth(req, res, next);
  return expressAuthenticate(req, res, next);
}

/**
 * For SDK-authenticated requests: does a client-supplied project reference (UUID or name)
 * refer to the token's own project? Empty references are treated as "the token's project".
 */
export function sdkProjectMatches(req: AuthenticatedRequest, ref: unknown): boolean {
  if (!req.sdkToken || !req.projectId) return false;
  if (ref === undefined || ref === null || ref === '') return true;
  if (typeof ref !== 'string') return false;
  return ref === req.projectId || (!!req.sdkProjectName && ref === req.sdkProjectName);
}
