import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Environment } from '../entities/Environment';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { UserRole } from '../entities/User';
import { AuthenticatedRequest, expressAuthenticate, expressRequireRole, logAudit } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { AutoscalingError, autoscalingNamespace, validateAutoscaling } from '../lib/autoscaling';
import { applyEnvironmentAutoscaling, readEnvironmentAutoscaling } from '../lib/autoscaling-k8s';
import { acquireLock, getLockHolder, LockBusyError, lockBusyBody, projectLockKey } from '../lib/locks';

const router = Router();
const path = '/projects/:projectId/environments/:environmentId/autoscaling';

async function handle(req: Request, res: Response, write: boolean) {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, write ? ProjectAccessRole.DEVOPS : ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const ds = await getDb();
    const repo = ds.getRepository(Environment);
    const env = await repo.findOne({ where: { id: req.params.environmentId, projectId: req.params.projectId } });
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    if (!write) return res.json(await readEnvironmentAutoscaling(env));
    const settings = validateAutoscaling(req.body, env.name === 'preview');
    const key = projectLockKey(env.projectId, 'deploy', env.id);
    const lock = await acquireLock(key, { holder: `autoscaling:${env.id}`, ttlMs: 60_000 });
    if (!lock) throw new LockBusyError(key, await getLockHolder(key));
    try {
      const others = await repo.find({ where: { namespace: autoscalingNamespace(env) } });
      if (others.some(other => other.projectId !== env.projectId)) throw new AutoscalingError('Namespace is shared with another project; administrator migration required', 409);
      await applyEnvironmentAutoscaling(env, settings);
      env.autoscaling = settings;
      await repo.save(env);
      await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'environment.autoscaling.updated', targetType: 'Environment', targetId: env.id, metadata: settings, ip: req.ip });
      return res.json(await readEnvironmentAutoscaling(env));
    } finally { await lock.release(); }
  } catch (e: any) {
    if (e instanceof LockBusyError) return res.status(409).json(lockBusyBody(e));
    return res.status(e instanceof AutoscalingError ? e.status : 503).json({ error: e instanceof AutoscalingError ? e.message : 'Autoscaling could not be reconciled; retry when the cluster is available' });
  }
}

router.get(path, expressAuthenticate, (req, res) => handle(req, res, false));
router.put(path, expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), (req, res) => handle(req, res, true));
export default router;
