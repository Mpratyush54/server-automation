import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project, StackType } from '../entities/Project';
import { Environment, EnvironmentName } from '../entities/Environment';
import { SdkCredential } from '../entities/SdkCredential';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { UserRole } from '../entities/User';
import * as k8s from '@kubernetes/client-node';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.get('/projects', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const projects = await ds.getRepository(Project).find({
      relations: ['environments', 'deployments'],
    });
    return res.json(projects);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/projects', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();

    const project = ds.getRepository(Project).create({
      name: body.name,
      stack: body.stack,
      description: body.description,
      repositoryUrl: body.repositoryUrl,
      domain: body.domain,
      clickupListId: body.clickupListId,
      createdById: (req as AuthenticatedRequest).user?.id,
    });
    const saved = await ds.getRepository(Project).save(project);
    const projectSlug = saved.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');

    // Create Environments: development, staging, production
    const envRepo = ds.getRepository(Environment);
    const envNames = [EnvironmentName.STAGING, EnvironmentName.PRODUCTION];
    
    // Also include development environment dynamically
    const devEnv = envRepo.create({
      name: 'development' as any,
      namespace: `${projectSlug}-development`,
      domain: body.domain ? `${projectSlug}-development.${body.domain}` : `${projectSlug}-development.example.com`,
      projectId: saved.id,
    });
    await envRepo.save(devEnv);

    for (const name of envNames) {
      const env = envRepo.create({
        name,
        namespace: `${projectSlug}-${name}`,
        domain: body.domain ? `${projectSlug}-${name}.${body.domain}` : `${projectSlug}-${name}.example.com`,
        projectId: saved.id,
      });
      await envRepo.save(env);
    }

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'project.created',
      targetType: 'Project',
      targetId: saved.id,
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/projects/:id', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({
      where: { id: req.params.id },
      relations: ['environments', 'deployments'],
    });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    return res.json(project);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/projects/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Project);

    const project = await repo.findOne({ where: { id: req.params.id } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const allowedFields = ['name', 'stack', 'description', 'repositoryUrl', 'domain', 'clickupListId'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        (project as any)[field] = body[field];
      }
    }

    const updated = await repo.save(project);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'project.updated',
      targetType: 'Project',
      targetId: updated.id,
      ip: req.ip,
    });

    return res.json(updated);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/projects/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Project);

    const project = await repo.findOne({ where: { id: req.params.id } });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    project.deletedAt = new Date();
    project.isActive = false;
    await repo.save(project);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'project.deleted',
      targetType: 'Project',
      targetId: project.id,
      ip: req.ip,
    });

    return res.json({ message: 'Project soft-deleted' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/projects/:projectId/tokens', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const tokens = await ds.getRepository(SdkCredential).find({
      where: { projectId: req.params.projectId },
      order: { createdAt: 'DESC' }
    });
    // Mask tokens before returning
    const maskedTokens = tokens.map(t => ({
      id: t.id,
      name: t.name,
      token: `${t.token.substring(0, 14)}...${t.token.substring(t.token.length - 4)}`,
      status: t.status,
      createdAt: t.createdAt
    }));
    return res.json(maskedTokens);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/projects/:projectId/tokens', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Token name is required' });

    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Generate secure token key
    const rawToken = `sdk_live_${uuidv4().replace(/-/g, '')}`;

    const credential = ds.getRepository(SdkCredential).create({
      projectId: project.id,
      name,
      token: rawToken,
      status: 'active'
    });
    
    const saved = await ds.getRepository(SdkCredential).save(credential);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'sdk_token.created',
      targetType: 'SdkCredential',
      targetId: saved.id,
      ip: req.ip,
    });

    // Return the plaintext token only this once!
    return res.status(201).json({
      id: saved.id,
      name: saved.name,
      token: rawToken, // Return plaintext so developer can copy it
      status: saved.status,
      createdAt: saved.createdAt
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/projects/:projectId/tokens/:tokenId', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const token = await ds.getRepository(SdkCredential).findOne({
      where: { id: req.params.tokenId, projectId: req.params.projectId }
    });
    if (!token) return res.status(404).json({ error: 'SDK Token not found' });

    await ds.getRepository(SdkCredential).remove(token);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'sdk_token.deleted',
      targetType: 'SdkCredential',
      targetId: req.params.tokenId,
      ip: req.ip,
    });

    return res.json({ success: true, message: 'SDK Token revoked' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/projects/:projectId/argocd-status', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const kc = new k8s.KubeConfig();
    try {
      kc.loadFromDefault();
      const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
      const appName = `${project.name}-staging`.toLowerCase();
      
      const appResponse: any = await customApi.getNamespacedCustomObject({
        group: 'argoproj.io',
        version: 'v1alpha1',
        namespace: 'argocd',
        plural: 'applications',
        name: appName
      });
      
      const app = appResponse.body || appResponse;
      const status = app.status || {};
      return res.json({
        connected: true,
        appName,
        syncStatus: status.sync?.status || 'Unknown',
        healthStatus: status.health?.status || 'Unknown',
        revision: status.sync?.revision || 'Unknown',
        syncTime: status.sync?.comparedTo?.time || null
      });
    } catch (err: any) {
      return res.json({
        connected: false,
        error: `Could not reach ArgoCD: ${err.message}`,
        syncStatus: 'Offline',
        healthStatus: 'Unknown'
      });
    }
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
