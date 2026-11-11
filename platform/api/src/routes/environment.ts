/**
 * Environment tab API (#29): one merged view of plain config values and encrypted secrets.
 *
 *   GET    /projects/:projectId/environment?environmentId=   merged rows (secrets always masked)
 *   PUT    /projects/:projectId/environment/:key             write plain or secret (moves between stores)
 *   DELETE /projects/:projectId/environment/:key?environmentId=&type=plain|secret
 *
 * Revealing a secret value stays on POST /projects/:projectId/secrets/reveal (permission,
 * MFA step-up and the `secrets.reveal` audit entry). The old /config and /projects/:id/secrets
 * endpoints remain for SDK/CLI compatibility.
 */
import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { getDb } from '../config/database';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { Environment } from '../entities/Environment';
import { User } from '../entities/User';
import { ProjectAccessRole, PROJECT_ROLE_RANK } from '../entities/ProjectMember';
import {
  expressAuthenticate, getUserPermissions, logAudit, requireRecentMfa, AuthenticatedRequest,
} from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { affectsTelemetryOrigins, requestTelemetryOriginsSync } from '../lib/telemetry-origins';
import {
  buildEnvironmentRows, deleteEnvironmentVariable, setEnvironmentVariable, findVariable,
  isValidEnvKey, EnvVarError, ScopeFilter, EnvVarType,
} from '../lib/environment-vars';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EnvironmentCapabilities {
  canReadValues: boolean;
  canReveal: boolean;
  canWritePlain: boolean;
  canWriteSecret: boolean;
  canDeletePlain: boolean;
  canDeleteSecret: boolean;
  canImport: boolean;
  canExport: boolean;
  canViewHistory: boolean;
  canRollback: boolean;
}

const NONE: EnvironmentCapabilities = {
  canReadValues: false, canReveal: false, canWritePlain: false, canWriteSecret: false,
  canDeletePlain: false, canDeleteSecret: false, canImport: false, canExport: false, canViewHistory: false, canRollback: false,
};

/**
 * What the caller may do here: RBAC permission AND project role developer+ (global admin/devops
 * have no membership row and pass). Viewers and agent tokens get keys + types only.
 */
export async function environmentCapabilities(
  req: AuthenticatedRequest,
  membership: { role: ProjectAccessRole } | null,
): Promise<EnvironmentCapabilities> {
  if (!req.user || !req.humanJwt || req.agentToken || req.sdkToken) return { ...NONE };
  const developerPlus = !membership || PROJECT_ROLE_RANK[membership.role] >= PROJECT_ROLE_RANK[ProjectAccessRole.DEVELOPER];
  if (!developerPlus) return { ...NONE };
  const p = await getUserPermissions(req.user);
  return {
    canReadValues: p.has('config.read'),
    canReveal: p.has('secrets.reveal'),
    canWritePlain: p.has('config.update'),
    canWriteSecret: p.has('secrets.create'),
    canDeletePlain: p.has('config.delete'),
    canDeleteSecret: p.has('secrets.delete'),
    canImport: p.has('secrets.import'),
    canExport: p.has('secrets.export'),
    canViewHistory: p.has('secrets.list'),
    canRollback: p.has('secrets.rollback'),
  };
}

/** environmentId query → scope filter. '' / 'global' = global rows only; id or name = effective view. */
async function resolveScope(projectId: string, raw: unknown): Promise<{ filter: ScopeFilter; environment: { id: string; name: string } | null } | { error: string }> {
  if (raw === undefined) return { filter: {}, environment: null };
  if (typeof raw !== 'string') return { error: 'environmentId must be a string' };
  if (raw === '' || raw === 'global') return { filter: { match: null }, environment: null };
  if (raw.length > 50) return { error: 'environmentId is too long' };
  const ds = await getDb();
  const repo = ds.getRepository(Environment);
  const env = UUID_RE.test(raw)
    ? await repo.findOne({ where: { id: raw, projectId } })
    : await repo.findOne({ where: { name: raw as any, projectId } });
  // Rows may be scoped by environment id (portal) or name (provisioned DB credentials).
  if (env) return { filter: { match: [env.id, env.name] }, environment: { id: env.id, name: env.name } };
  return { filter: { match: [raw] }, environment: null };
}

function normaliseEnvId(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '' || raw === 'global') return { ok: true, value: null };
  if (typeof raw !== 'string' || raw.length > 50) return { ok: false, error: 'environmentId must be a string of at most 50 characters' };
  return { ok: true, value: raw };
}

function runMiddleware(mw: (req: Request, res: Response, next: () => void) => unknown, req: Request, res: Response): Promise<boolean> {
  return new Promise((resolve) => {
    let passed = false;
    const done = () => { passed = true; resolve(true); };
    Promise.resolve(mw(req, res, done)).then(() => { if (!passed) resolve(false); }, () => resolve(false));
  });
}

router.get('/projects/:projectId/environment', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const projectId = req.params.projectId;
    const access = await requireProjectAccess(authReq, projectId, ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    const scope = await resolveScope(projectId, req.query.environmentId);
    if ('error' in scope) return res.status(400).json({ error: scope.error });

    const caps = await environmentCapabilities(authReq, access.membership);
    const ds = await getDb();
    const configs = await ds.getRepository(ProjectConfig).find({ where: { projectId } });
    const secrets = await ds.getRepository(Secret).find({ where: { projectId, isActive: true } });

    const ids = Array.from(new Set([
      ...configs.map((c) => c.changedById), ...secrets.map((s) => s.createdById),
    ].filter((v): v is string => !!v)));
    const userNames: Record<string, string> = {};
    if (ids.length) {
      try {
        const users = await ds.getRepository(User).find({ where: { id: In(ids) } as any });
        for (const u of users || []) userNames[u.id] = u.name || u.email || u.id;
      } catch { /* names are cosmetic */ }
    }

    const variables = buildEnvironmentRows(
      configs.filter((c) => c.projectId === projectId),
      secrets.filter((s) => s.projectId === projectId),
      { filter: scope.filter, canReadValues: caps.canReadValues, userNames },
    );
    return res.json({
      projectId,
      environmentId: req.query.environmentId === undefined ? null : (scope.environment?.id ?? (req.query.environmentId || 'global')),
      environment: scope.environment,
      capabilities: caps,
      conflicts: variables.filter((v) => v.conflict).length,
      variables,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/projects/:projectId/environment/:key', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { projectId, key } = req.params;
    const body = req.body || {};
    if (!isValidEnvKey(key)) {
      return res.status(400).json({ error: 'key must start with a letter or underscore and contain only letters, digits, _ . - (max 200)' });
    }
    if (typeof body.secret !== 'boolean') return res.status(400).json({ error: 'secret must be a boolean' });
    if (body.value !== undefined && typeof body.value !== 'string') return res.status(400).json({ error: 'value must be a string' });
    const env = normaliseEnvId(body.environmentId);
    if (env.ok === false) return res.status(400).json({ error: env.error });

    const access = await requireProjectAccess(authReq, projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    if (!authReq.user || !authReq.humanJwt) return res.status(401).json({ error: 'Unauthorized: Human JWT required' });
    const caps = await environmentCapabilities(authReq, access.membership);

    const ds = await getDb();
    const existing = await findVariable(ds, projectId, env.value, key);
    const secret = body.secret as boolean;
    if (secret) {
      if (!caps.canWriteSecret) return res.status(403).json({ error: 'Forbidden: requires secrets.create', required: ['secrets.create'] });
      // Moving a plain value into the secret store edits config storage too.
      if (existing.plain && !caps.canWritePlain) return res.status(403).json({ error: 'Forbidden: converting a plain value requires config.update', required: ['config.update'] });
    } else {
      if (!caps.canWritePlain) return res.status(403).json({ error: 'Forbidden: requires config.update', required: ['config.update'] });
      if (existing.secret) {
        // Turning a secret into plaintext exposes it: needs delete + reveal rights and a fresh second factor.
        if (!caps.canDeleteSecret || !caps.canReveal) {
          return res.status(403).json({ error: 'Forbidden: converting a secret to plain requires secrets.delete and secrets.reveal', required: ['secrets.delete', 'secrets.reveal'] });
        }
        if (!(await runMiddleware(requireRecentMfa(), req, res))) return; // 401 step_up_required already sent
      }
    }

    const masterKey = process.env.SECRETS_ENCRYPTION_KEY || '';
    if ((secret || existing.secret) && !masterKey) return res.status(500).json({ error: 'SECRETS_ENCRYPTION_KEY not configured' });

    const result = await setEnvironmentVariable(ds, {
      projectId, environmentId: env.value, key, value: body.value, secret, userId: authReq.user.id, masterKey,
    });

    if (affectsTelemetryOrigins(key)) requestTelemetryOriginsSync();
    const action = secret ? (result.status === 'created' ? 'secrets.create' : 'secrets.update') : 'config.update';
    await logAudit({
      userId: authReq.user.id,
      action,
      targetType: secret ? 'Secret' : 'ProjectConfig',
      targetId: result.secretId || projectId,
      metadata: {
        via: 'PUT /environment', projectId, key, environmentId: env.value,
        type: result.type, status: result.status, convertedFrom: result.convertedFrom, version: result.version,
      },
      ip: req.ip,
    });
    return res.status(result.status === 'created' ? 201 : 200).json(result);
  } catch (err: any) {
    if (err instanceof EnvVarError) return res.status(err.status).json({ error: err.message });
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/projects/:projectId/environment/:key', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { projectId, key } = req.params;
    const type = req.query.type as EnvVarType;
    if (!isValidEnvKey(key)) return res.status(400).json({ error: 'invalid key' });
    if (type !== 'plain' && type !== 'secret') return res.status(400).json({ error: 'type must be plain or secret' });
    const env = normaliseEnvId(req.query.environmentId);
    if (env.ok === false) return res.status(400).json({ error: env.error });

    const access = await requireProjectAccess(authReq, projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    if (!authReq.user || !authReq.humanJwt) return res.status(401).json({ error: 'Unauthorized: Human JWT required' });
    const caps = await environmentCapabilities(authReq, access.membership);
    if (type === 'plain' && !caps.canDeletePlain) return res.status(403).json({ error: 'Forbidden: requires config.delete', required: ['config.delete'] });
    if (type === 'secret' && !caps.canDeleteSecret) return res.status(403).json({ error: 'Forbidden: requires secrets.delete', required: ['secrets.delete'] });

    const ds = await getDb();
    const result = await deleteEnvironmentVariable(ds, { projectId, environmentId: env.value, key, type });
    if (!result.deleted) return res.status(404).json({ error: 'Variable not found' });
    if (affectsTelemetryOrigins(key)) requestTelemetryOriginsSync();

    await logAudit({
      userId: authReq.user.id,
      action: type === 'secret' ? 'secrets.delete' : 'config.delete',
      targetType: type === 'secret' ? 'Secret' : 'ProjectConfig',
      targetId: result.secretId || projectId,
      metadata: { via: 'DELETE /environment', projectId, key, environmentId: env.value },
      ip: req.ip,
    });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
