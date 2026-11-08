import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { Project } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { ProjectConfig } from '../entities/ProjectConfig';
import { Secret } from '../entities/Secret';
import { UserRole } from '../entities/User';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { expressAuthenticate, expressRequireRole, getUserPermissions, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { resolveProjectRef } from '../lib/project-resolve';
import { decryptValue } from '../lib/secrets-encryption';
import { FeatureFlagModel } from '../schemas/FeatureFlag';

const router = Router();

router.get('/config', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    let { projectId, environmentId } = req.query as Record<string, string>;
    // projectId is mandatory: TypeORM drops undefined where-keys, so an omitted
    // projectId would otherwise match every project's rows.
    if (!projectId || typeof projectId !== 'string') {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (environmentId !== undefined && typeof environmentId !== 'string') {
      return res.status(400).json({ error: 'environmentId must be a string' });
    }
    const ds = await getDb();

    // Resolve project name to UUID if needed
    const project = await resolveProjectRef(ds, projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    projectId = project.id;

    const authReq = req as AuthenticatedRequest;
    const access = await requireProjectAccess(authReq, projectId, ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    // Resolve environment name to UUID if needed
    if (environmentId && !environmentId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      const envRepo = ds.getRepository(Environment);
      const env = await envRepo.findOne({ where: { name: environmentId as any, projectId } });
      if (env) environmentId = env.id;
    }

    const configRepo = ds.getRepository(ProjectConfig);
    const configs = await configRepo.find({ where: { projectId } });
    const result: Record<string, string> = {};
    for (const c of configs) {
      if (c.projectId && c.projectId !== projectId) continue;
      if (c.environmentId && environmentId && c.environmentId !== environmentId) continue;
      result[c.key] = c.isSecret ? '***' : c.value;
    }

    // Secrets from the Secret entity: masked unless the caller holds secrets.reveal
    // (same permission + audit trail as POST /projects/:id/secrets/reveal).
    const secretRepo = ds.getRepository(Secret);
    const secrets = (await secretRepo.find({ where: { isActive: true, projectId } }))
      .filter((s) => !s.projectId || s.projectId === projectId)
      .filter((s) => !(s.environmentId && environmentId && s.environmentId !== environmentId));

    let canReveal = false;
    if (authReq.user && authReq.humanJwt && !authReq.agentToken && !authReq.sdkToken) {
      const perms = await getUserPermissions(authReq.user);
      canReveal = perms.has('secrets.reveal');
    }
    const masterKey = process.env.SECRETS_ENCRYPTION_KEY;
    const revealedKeys: string[] = [];
    for (const s of secrets) {
      if (canReveal && masterKey) {
        try {
          result[s.key] = decryptValue(s.encryptedValue, masterKey);
          revealedKeys.push(s.key);
          continue;
        } catch {}
      }
      result[s.key] = '***';
    }
    if (revealedKeys.length) {
      logAudit({
        userId: authReq.user?.id,
        action: 'secrets.reveal',
        targetType: 'Project',
        targetId: projectId,
        metadata: { via: 'GET /config', environmentId: environmentId || null, keys: revealedKeys },
        ip: req.ip,
      });
    }

    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/config', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body?.projectId || typeof body.projectId !== 'string' || !body.key) {
      return res.status(400).json({ error: 'projectId and key are required' });
    }
    const access = await requireProjectAccess(req as AuthenticatedRequest, body.projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const ds = await getDb();
    const repo = ds.getRepository(ProjectConfig);

    let config = await repo.findOne({
      where: { projectId: body.projectId, key: body.key, environmentId: body.environmentId || null },
    });

    if (config) {
      config.value = body.value;
      config.isSecret = body.isSecret || false;
      config.changedById = (req as AuthenticatedRequest).user?.id || null;
      await repo.save(config);
    } else {
      config = repo.create({
        projectId: body.projectId,
        key: body.key,
        value: body.value,
        environmentId: body.environmentId || null,
        isSecret: body.isSecret || false,
        changedById: (req as AuthenticatedRequest).user?.id || null,
      });
      await repo.save(config);
    }

    return res.status(201).json(config);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/config', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, string>;
    const b = (req.body || {}) as Record<string, string>;
    const projectId = q.projectId || b.projectId;
    const key = q.key || b.key;
    const environmentId = q.environmentId || b.environmentId;
    if (!projectId || !key || typeof projectId !== 'string' || typeof key !== 'string') {
      return res.status(400).json({ error: 'projectId and key are required' });
    }
    const access = await requireProjectAccess(req as AuthenticatedRequest, projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const ds = await getDb();
    const repo = ds.getRepository(ProjectConfig);
    const config = await repo.findOne({
      where: { projectId, key, environmentId: environmentId || null },
    });
    if (!config) {
      return res.status(404).json({ error: 'Config not found' });
    }
    await repo.remove(config);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/config/feature-flags', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    if (typeof body.projectId !== 'string' || !body.projectId || typeof body.key !== 'string' || !body.key
      || (body.environmentId !== undefined && body.environmentId !== null && typeof body.environmentId !== 'string')) {
      return res.status(400).json({ error: 'projectId and key are required strings' });
    }
    const access = await requireProjectAccess(req as AuthenticatedRequest, body.projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    await connectMongo();
    const flag = await FeatureFlagModel.findOneAndUpdate(
      { projectId: body.projectId, environmentId: body.environmentId, key: body.key },
      { $set: { value: body.value, isEnabled: body.isEnabled !== false } },
      { upsert: true, new: true }
    );
    return res.status(201).json(flag);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
