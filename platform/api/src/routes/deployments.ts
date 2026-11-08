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
import { enqueueDeployment, markFailed } from '../lib/deploy-pipeline';

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

router.post('/deploy', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD, UserRole.DEVELOPER]), async (req: Request, res: Response) => {
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

    // Durable rollout: persisted as a background job and started on this
    // replica; the leader resumes or fails it if this process dies mid-way.
    try {
      await enqueueDeployment(saved.id);
    } catch (enqueueErr: any) {
      await markFailed(saved.id, `Could not schedule deployment: ${enqueueErr.message}`).catch(() => {});
      return res.status(500).json({ error: 'Could not schedule deployment' });
    }

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/rollback', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
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
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/deployments/:id/restart', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);
    const deployment = await repo.findOne({ where: { id: req.params.id } });
    if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, deployment.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    await controlDeployment(deployment, 'restart');
    deployment.status = DeploymentStatus.DEPLOYED;
    deployment.deployedAt = new Date();
    await repo.save(deployment);

    return res.json({ message: 'Restart triggered', deployment });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/deployments/:id/scale', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);
    const dep = await repo.findOne({ where: { id: req.params.id } });
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, dep.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    if (!Number.isInteger(body.replicas) || body.replicas < 0 || body.replicas > 1000) return res.status(400).json({ error: 'replicas must be an integer between 0 and 1000' });
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
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/deployments/:id/terminate', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD, UserRole.DEVELOPER]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);
    const dep = await repo.findOne({ where: { id: req.params.id } });
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, dep.projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

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
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
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
