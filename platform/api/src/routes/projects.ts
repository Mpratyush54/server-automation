import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project, StackType } from '../entities/Project';
import { Environment, EnvironmentName } from '../entities/Environment';
import { SdkCredential } from '../entities/SdkCredential';
import { User } from '../entities/User';
import { ProjectMember, ProjectAccessRole } from '../entities/ProjectMember';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { argoAppName } from '../lib/k8s';
import { fetchRepoBranches, fetchBranchCommits, fetchRepoReleases } from '../lib/git-remote';
import { assignedNamespace, assignedEnvHost } from '../lib/project-namespace';
import {
  listAccessibleProjectIds,
  ensureProjectOwner,
  requireProjectAccess,
  isGlobalProjectAdmin,
} from '../lib/project-access';
import { In } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.get('/projects', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken && !(authReq.agentToken.scopes.includes('projects:read') || authReq.agentToken.scopes.includes('*'))) {
      return res.status(403).json({ error: 'Forbidden: Agent token missing projects:read scope' });
    }
    const ids = await listAccessibleProjectIds(authReq.user, authReq.agentToken);
    const repo = ds.getRepository(Project);
    const projects = ids === null
      ? await repo.find({ where: { isActive: true }, relations: ['environments', 'deployments'] })
      : ids.length === 0
        ? []
        : await repo.find({
            where: { id: In(ids), isActive: true },
            relations: ['environments', 'deployments'],
          });
    return res.json(projects);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/projects', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const userId = (req as AuthenticatedRequest).user?.id;

    const project = ds.getRepository(Project).create({
      name: body.name,
      stack: body.stack,
      description: body.description,
      repositoryUrl: body.repositoryUrl,
      domain: body.domain,
      clickupListId: body.clickupListId,
      createdById: userId,
    });
    const saved = await ds.getRepository(Project).save(project);
    const baseDomain = body.domain || process.env.DOMAIN || 'example.com';

    const envRepo = ds.getRepository(Environment);
    const envNames = ['development', EnvironmentName.STAGING, EnvironmentName.PRODUCTION];
    for (const name of envNames) {
      const env = envRepo.create({
        name: name as any,
        namespace: assignedNamespace(saved.name, name),
        domain: assignedEnvHost(saved.name, name, baseDomain),
        projectId: saved.id,
      });
      await envRepo.save(env);
    }

    if (userId) {
      await ensureProjectOwner(saved.id, userId);
    }

    await logAudit({
      userId,
      action: 'project.created',
      targetType: 'Project',
      targetId: saved.id,
      ip: req.ip,
    });

    const withRelations = await ds.getRepository(Project).findOne({
      where: { id: saved.id },
      relations: ['environments', 'deployments'],
    });
    return res.status(201).json(withRelations || saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/projects/:id', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

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

router.put('/projects/:id', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, ProjectAccessRole.DEVOPS);
    const allowedByPlatform =
      !!user &&
      (isGlobalProjectAdmin(user) || user.role === UserRole.TECH_LEAD);
    if (!access.ok && !allowedByPlatform) {
      const denied = access as { ok: false; status: number; error: string };
      return res.status(denied.status).json({ error: denied.error });
    }

    const body = req.body;
    if (body.namespace || body.environments?.some?.((e: any) => e.namespace)) {
      return res.status(400).json({
        error: 'Namespaces are assigned by the server and cannot be changed',
      });
    }

    const ds = await getDb();
    const repo = ds.getRepository(Project);

    const project = await repo.findOne({ where: { id: req.params.id }, relations: ['environments'] });
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const allowedFields = ['name', 'stack', 'description', 'repositoryUrl', 'domain', 'clickupListId'];
    const domainChanged = body.domain !== undefined && body.domain !== project.domain;
    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        (project as any)[field] = body[field];
      }
    }

    const updated = await repo.save(project);

    if (domainChanged && updated.domain) {
      const envRepo = ds.getRepository(Environment);
      const envs = await envRepo.find({ where: { projectId: updated.id } });
      for (const env of envs) {
        // Re-assert server namespace + host (never accept client namespace)
        env.namespace = assignedNamespace(updated.name, env.name);
        env.domain = assignedEnvHost(updated.name, env.name, updated.domain);
        await envRepo.save(env);
      }
    }

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'project.updated',
      targetType: 'Project',
      targetId: updated.id,
      ip: req.ip,
    });

    const fresh = await repo.findOne({ where: { id: updated.id }, relations: ['environments', 'deployments'] });
    return res.json(fresh || updated);
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
    const project = await ds.getRepository(Project).findOne({
      where: { id: req.params.projectId },
      relations: ['environments'],
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const envHint = String(req.query.env || 'development');
    const appName = argoAppName(project.name, envHint);

    const kc = new k8s.KubeConfig();
    try {
      try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
      const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

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
        repositoryUrl: project.repositoryUrl,
        domain: project.domain,
        syncStatus: status.sync?.status || 'Unknown',
        healthStatus: status.health?.status || 'Unknown',
        revision: status.sync?.revision || 'Unknown',
        syncTime: status.operationState?.finishedAt || status.reconciledAt || null
      });
    } catch (err: any) {
      return res.json({
        connected: false,
        appName,
        repositoryUrl: project.repositoryUrl,
        domain: project.domain,
        error: `Could not reach ArgoCD app '${appName}': ${err.message}`,
        syncStatus: 'Offline',
        healthStatus: 'Unknown'
      });
    }
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/** List branches (+ tip SHAs) from the project's GitHub/GitLab repository. */
router.get('/projects/:projectId/git/branches', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.repositoryUrl) {
      return res.status(400).json({ error: 'Project has no repositoryUrl — set a GitHub/GitLab URL first' });
    }
    const data = await fetchRepoBranches(project.repositoryUrl);
    return res.json({
      repositoryUrl: project.repositoryUrl,
      ...data,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/** List recent commits for a branch from the project's Git repository. */
router.get('/projects/:projectId/git/commits', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.repositoryUrl) {
      return res.status(400).json({ error: 'Project has no repositoryUrl — set a GitHub/GitLab URL first' });
    }
    const branch = String(req.query.branch || 'main');
    const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 50);
    const commits = await fetchBranchCommits(project.repositoryUrl, branch, limit);
    return res.json({
      repositoryUrl: project.repositoryUrl,
      branch,
      commits,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/** List GitHub/GitLab releases so the UI can offer one-click update. */
router.get('/projects/:projectId/git/releases', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({
      where: { id: req.params.projectId },
      relations: ['deployments'],
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.repositoryUrl) {
      return res.status(400).json({ error: 'Project has no repositoryUrl — set a GitHub/GitLab URL first' });
    }
    const limit = Math.min(parseInt(String(req.query.limit || '10'), 10) || 10, 30);
    const releases = await fetchRepoReleases(project.repositoryUrl, limit);
    const latestDeployed = (project.deployments || [])
      .slice()
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .find((d: any) => ['deployed', 'active'].includes(String(d.status)));
    const currentVersion = latestDeployed?.version || latestDeployed?.imageTag || null;
    const currentTag = latestDeployed?.imageTag || latestDeployed?.version || null;
    const latestRelease = releases.find((r) => !r.prerelease) || releases[0] || null;
    const updateAvailable = !!(
      latestRelease &&
      currentTag &&
      latestRelease.tag !== currentTag &&
      latestRelease.tag !== `v${currentTag}` &&
      latestRelease.tag.replace(/^v/, '') !== String(currentTag).replace(/^v/, '')
    );

    return res.json({
      repositoryUrl: project.repositoryUrl,
      currentVersion,
      currentTag,
      updateAvailable,
      latestRelease,
      releases,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ─── Project-level access (members) ─────────────────────────────────────────

router.get('/projects/:id/members', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, ProjectAccessRole.VIEWER);
    if (access.ok === false && !isGlobalProjectAdmin((req as AuthenticatedRequest).user)) {
      return res.status(access.status).json({ error: access.error });
    }
    const ds = await getDb();
    const members = await ds.getRepository(ProjectMember).find({
      where: { projectId: req.params.id },
      order: { createdAt: 'ASC' as any },
    });
    const users = members.length
      ? await ds.getRepository(User).find({ where: { id: In(members.map((m) => m.userId)) } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return res.json(members.map((m) => {
      const u = byId.get(m.userId);
      return {
        id: m.id,
        projectId: m.projectId,
        userId: m.userId,
        role: m.role,
        grantedById: m.grantedById,
        createdAt: m.createdAt,
        user: u
          ? { id: u.id, name: u.name, email: u.email, username: u.username, platformRole: u.role }
          : null,
      };
    }));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/projects/:id/members', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, ProjectAccessRole.OWNER);
    const user = (req as AuthenticatedRequest).user;
    if (access.ok === false && !isGlobalProjectAdmin(user)) {
      return res.status(access.status).json({
        error: access.error || 'Forbidden: only project owners (or platform admin/devops) can grant access',
      });
    }

    const { userId, email, role } = req.body || {};
    const accessRole = (role as ProjectAccessRole) || ProjectAccessRole.VIEWER;
    if (!Object.values(ProjectAccessRole).includes(accessRole)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${Object.values(ProjectAccessRole).join(', ')}` });
    }

    const ds = await getDb();
    const userRepo = ds.getRepository(User);
    let target = userId ? await userRepo.findOne({ where: { id: userId } }) : null;
    if (!target && email) {
      target = await userRepo.findOne({ where: { email } });
    }
    if (!target) {
      return res.status(404).json({ error: 'User not found — create the user first, then grant project access' });
    }

    const memberRepo = ds.getRepository(ProjectMember);
    let member = await memberRepo.findOne({ where: { projectId: req.params.id, userId: target.id } });
    if (member) {
      member.role = accessRole;
      member.grantedById = user?.id || null;
      member = await memberRepo.save(member);
    } else {
      member = await memberRepo.save(memberRepo.create({
        projectId: req.params.id,
        userId: target.id,
        role: accessRole,
        grantedById: user?.id || null,
      }));
    }

    await logAudit({
      userId: user?.id,
      action: 'project.member.granted',
      targetType: 'Project',
      targetId: req.params.id,
      metadata: { memberUserId: target.id, role: accessRole },
      ip: req.ip,
    });

    return res.status(201).json({
      id: member.id,
      projectId: member.projectId,
      userId: member.userId,
      role: member.role,
      user: { id: target.id, name: target.name, email: target.email, username: target.username },
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/projects/:id/members/:memberId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, ProjectAccessRole.OWNER);
    const user = (req as AuthenticatedRequest).user;
    if (access.ok === false && !isGlobalProjectAdmin(user)) {
      return res.status(access.status).json({ error: access.error });
    }
    const { role } = req.body || {};
    if (!Object.values(ProjectAccessRole).includes(role)) {
      return res.status(400).json({ error: `Invalid role. Allowed: ${Object.values(ProjectAccessRole).join(', ')}` });
    }
    const ds = await getDb();
    const memberRepo = ds.getRepository(ProjectMember);
    const member = await memberRepo.findOne({ where: { id: req.params.memberId, projectId: req.params.id } });
    if (!member) return res.status(404).json({ error: 'Membership not found' });
    member.role = role;
    member.grantedById = user?.id || null;
    await memberRepo.save(member);
    return res.json(member);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/projects/:id/members/:memberId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, ProjectAccessRole.OWNER);
    const user = (req as AuthenticatedRequest).user;
    if (access.ok === false && !isGlobalProjectAdmin(user)) {
      return res.status(access.status).json({ error: access.error });
    }
    const ds = await getDb();
    const memberRepo = ds.getRepository(ProjectMember);
    const member = await memberRepo.findOne({ where: { id: req.params.memberId, projectId: req.params.id } });
    if (!member) return res.status(404).json({ error: 'Membership not found' });
    if (member.role === ProjectAccessRole.OWNER) {
      const owners = await memberRepo.count({ where: { projectId: req.params.id, role: ProjectAccessRole.OWNER } });
      if (owners <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last project owner' });
      }
    }
    await memberRepo.remove(member);
    await logAudit({
      userId: user?.id,
      action: 'project.member.revoked',
      targetType: 'Project',
      targetId: req.params.id,
      metadata: { memberUserId: member.userId },
      ip: req.ip,
    });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
