import { requireProjectAccess } from '../lib/project-access';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { Environment, EnvironmentName } from '../entities/Environment';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { triggerPipeline } from '../lib/gitlab';
import { extractTaskId } from '../lib/clickup';
import { generatePreviewUrl } from '../lib/preview';
import { operateProjectWorkloads, terminateK8sPreview, previewResourceName } from '../lib/k8s';
import { acquireLock, getLockHolder, LockBusyError, LockHandle, lockBusyBody, projectLockKey } from '../lib/locks';
import { createOperation, newOperationId, runOperation } from '../lib/operations';
import { DEPLOY_OPERATION } from '../lib/deploy-op';
import { idempotency } from '../middleware/idempotency';

/**
 * One mutating deployment operation per project environment at a time (issue #23):
 * deploy, rollback, restart, scale and terminate share `lock:project:<id>:deploy:<envId>`.
 */
function deployLockKey(projectId: string, environmentId: string | null | undefined): string {
  return projectLockKey(projectId, 'deploy', environmentId || 'none');
}

async function lockDeployTarget(projectId: string, environmentId: string | null | undefined, holder: string, ttlMs = 60_000): Promise<LockHandle> {
  const key = deployLockKey(projectId, environmentId);
  const lock = await acquireLock(key, { holder, ttlMs });
  if (!lock) throw new LockBusyError(key, await getLockHolder(key));
  return lock;
}

function sendError(res: Response, err: any) {
  if (err instanceof LockBusyError) return res.status(409).json(lockBusyBody(err));
  return res.status(400).json({ error: err.message });
}

const router = Router();

router.get('/deployments/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const deployments = await ds.getRepository(Deployment).find({
      where: { projectId: req.params.projectId },
      order: { createdAt: 'DESC' },
    });
    return res.json(deployments);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/deploy', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD, UserRole.DEVELOPER]), idempotency('POST /deploy'), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();

    if (!body?.projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }
    if (!body?.environmentId && body.environmentName !== 'preview') {
      return res.status(400).json({ error: 'environmentId is required' });
    }

    const access = await requireProjectAccess(req as AuthenticatedRequest, String(body.projectId), ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    // Verify project and environment
    const project = await ds.getRepository(Project).findOne({ where: { id: body.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let env = body.environmentId
      ? await ds.getRepository(Environment).findOne({ where: { id: body.environmentId, projectId: project.id } })
      : null;
    if (!env) {
      // If it's a preview env, create on the fly
      if (body.environmentName === 'preview') {
        const previewRepo = ds.getRepository(Environment);
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
        const previewUrl = generatePreviewUrl(body.branch || 'preview', projectSlug, project.domain || process.env.DOMAIN || 'sslip.io', project.id);
        env = previewRepo.create({
          name: EnvironmentName.PREVIEW,
          namespace: 'preview',
          domain: previewUrl,
          projectId: project.id,
        });
        env = await previewRepo.save(env);
      } else {
        return res.status(404).json({ error: 'Environment not found' });
      }
    }

    if (env.name !== EnvironmentName.PREVIEW) await assertDedicatedNamespace(env);

    const clickupTaskId = body.branch ? extractTaskId(body.branch) : null;

    // Concurrent deploys of the same project environment: the second one gets 409.
    const operationId = newOperationId();
    const lockKey = deployLockKey(project.id, env.id);
    const lock = await lockDeployTarget(project.id, env.id, operationId);
    let handedOff = false;
    try {
      const deployment = ds.getRepository(Deployment).create({
        projectId: body.projectId,
        environmentId: env.id,
        version: body.version || '1.0.0',
        branch: body.branch || 'main',
        commitSha: body.commitSha || 'unknown',
        imageTag: body.imageTag || 'latest',
        status: DeploymentStatus.PENDING,
        deployedById: (req as AuthenticatedRequest).user?.id,
        clickupTaskId,
        previewUrl: env.name === EnvironmentName.PREVIEW ? `https://${env.domain}` : null,
        metadata: {
          previewResourceName: env.name === EnvironmentName.PREVIEW ? previewResourceName(project.id, body.branch || 'main') : undefined,
          gitPath: body.gitPath || undefined,
          pullFromGit: body.pullFromGit !== false,
          domain: project.domain || undefined,
        },
      });
      const saved = await ds.getRepository(Deployment).save(deployment);

      await logAudit({
        userId: (req as AuthenticatedRequest).user?.id,
        action: 'deployment.created',
        targetType: 'Deployment',
        targetId: saved.id,
        metadata: { projectId: body.projectId, environmentId: env.id, version: body.version },
        ip: req.ip,
      });

      // Step-logged background deploy (lib/deploy-op.ts); the runner owns and releases the lock.
      await createOperation(DEPLOY_OPERATION, {
        id: operationId,
        projectId: project.id,
        lockKey,
        input: { deploymentId: saved.id, environmentId: env.id, gitPath: body.gitPath || undefined },
        state: { deploymentId: saved.id },
        createdById: (req as AuthenticatedRequest).user?.id ?? null,
      });
      handedOff = true;
      setImmediate(() => {
        runOperation(operationId, { lock }).catch((err) => {
          console.error('[deploy-bg] Background deploy error:', err?.message || err);
        });
      });

      return res.status(201).json({ ...saved, operationId });
    } finally {
      if (!handedOff) await lock.release();
    }
  } catch (err: any) {
    return sendError(res, err);
  }
});

router.post('/rollback', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), idempotency('POST /rollback'), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body?.deploymentId) {
      return res.status(400).json({ error: 'deploymentId is required' });
    }
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);

    const current = await repo.findOne({ where: { id: body.deploymentId } });
    if (!current) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

    const access = await requireProjectAccess(req as AuthenticatedRequest, current.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const env = await ds.getRepository(Environment).findOne({ where: { id: current.environmentId, projectId: current.projectId } });
    if (!env) return res.status(404).json({ error: 'Deployment environment not found' });

    const lock = await lockDeployTarget(current.projectId, current.environmentId, `rollback:${newOperationId()}`);
    try {
      current.status = DeploymentStatus.ROLLED_BACK;
      current.terminatedAt = new Date();
      await repo.save(current);

      const rollback = repo.create({
        projectId: current.projectId,
        environmentId: current.environmentId,
        version: body.previousVersion || current.version,
        branch: current.branch,
        commitSha: current.commitSha,
        imageTag: current.imageTag,
        status: DeploymentStatus.DEPLOYED,
        deployedById: (req as AuthenticatedRequest).user?.id,
        metadata: { ...(current.metadata || {}), rollbackFrom: current.id },
        deployedAt: new Date(),
      });
      const saved = await repo.save(rollback);

      // Call GitLab Pipeline trigger simulating roll back
      await triggerPipeline(current.projectId, current.branch);

      await logAudit({
        userId: (req as AuthenticatedRequest).user?.id,
        action: 'deployment.rolled_back',
        targetType: 'Deployment',
        targetId: current.id,
        metadata: { rollbackDeploymentId: saved.id, previousVersion: body.previousVersion },
        ip: req.ip,
      });

      return res.status(201).json({ rolledBack: current, newDeployment: saved });
    } finally {
      await lock.release();
    }
  } catch (err: any) {
    return sendError(res, err);
  }
});

router.post('/deployments/:id/restart', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), idempotency('POST /deployments/:id/restart'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);
    const deployment = await repo.findOne({ where: { id: req.params.id } });
    if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, deployment.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    const lock = await lockDeployTarget(deployment.projectId, deployment.environmentId, `restart:${newOperationId()}`);
    try {
      await controlDeployment(deployment, 'restart');
      deployment.status = DeploymentStatus.DEPLOYED;
      deployment.deployedAt = new Date();
      await repo.save(deployment);

      return res.json({ message: 'Restart triggered', deployment });
    } finally {
      await lock.release();
    }
  } catch (err: any) {
    return sendError(res, err);
  }
});

router.patch('/deployments/:id/scale', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), idempotency('PATCH /deployments/:id/scale'), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);
    const dep = await repo.findOne({ where: { id: req.params.id } });
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, dep.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    if (!Number.isInteger(body.replicas) || body.replicas < 0 || body.replicas > 1000) return res.status(400).json({ error: 'replicas must be an integer between 0 and 1000' });

    const lock = await lockDeployTarget(dep.projectId, dep.environmentId, `scale:${newOperationId()}`);
    try {
      await controlDeployment(dep, 'scale', body.replicas);
      dep.metadata = { ...(dep.metadata || {}), replicas: body.replicas };
      await repo.save(dep);

      await logAudit({
        userId: (req as AuthenticatedRequest).user?.id,
        action: 'deployment.scaled',
        targetType: 'Deployment',
        targetId: dep.id,
        metadata: { replicas: body.replicas },
        ip: req.ip,
      });

      return res.json(dep);
    } finally {
      await lock.release();
    }
  } catch (err: any) {
    return sendError(res, err);
  }
});

router.post('/deployments/:id/terminate', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD, UserRole.DEVELOPER]), idempotency('POST /deployments/:id/terminate'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);
    const dep = await repo.findOne({ where: { id: req.params.id } });
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, dep.projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    const lock = await lockDeployTarget(dep.projectId, dep.environmentId, `terminate:${newOperationId()}`);
    try {
      await controlDeployment(dep, 'terminate');
      dep.status = DeploymentStatus.TERMINATED;
      dep.terminatedAt = new Date();
      await repo.save(dep);

      await logAudit({
        userId: (req as AuthenticatedRequest).user?.id,
        action: 'deployment.terminated',
        targetType: 'Deployment',
        targetId: dep.id,
        ip: req.ip,
      });

      return res.json(dep);
    } finally {
      await lock.release();
    }
  } catch (err: any) {
    return sendError(res, err);
  }
});

async function controlDeployment(dep: Deployment, operation: 'restart' | 'scale' | 'terminate', replicas?: number): Promise<void> {
  if (dep.metadata?.previewResourceName) {
    if (operation !== 'terminate') throw new Error('Preview restart and scale are not supported');
    if (!await terminateK8sPreview(dep.branch, dep.projectId, String(dep.metadata.previewResourceName))) throw new Error('Preview termination failed');
    return;
  }
  const ds = await getDb();
  const env = await ds.getRepository(Environment).findOne({ where: { id: dep.environmentId, projectId: dep.projectId } });
  if (!env) throw new Error('Deployment environment not found');
  if (env.name === EnvironmentName.PREVIEW) {
    if (operation !== 'terminate') throw new Error('Preview restart and scale are not supported');
    if (!await terminateK8sPreview(dep.branch, dep.projectId, dep.metadata?.previewResourceName as string | undefined)) throw new Error('Preview termination failed');
    return;
  }
  await assertDedicatedNamespace(env);
  await operateProjectWorkloads(env.namespace, env.namespace, operation, replicas);
}

async function assertDedicatedNamespace(env: Environment): Promise<void> {
  const ds = await getDb();
  const environments = await ds.getRepository(Environment).find({ where: { namespace: env.namespace } });
  if (environments.some(other => other.namespace === env.namespace && other.projectId !== env.projectId)) {
    throw new Error('Namespace is shared with another project; administrator migration required');
  }
}

export default router;
