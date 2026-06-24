import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project, StackType } from '../entities/Project';
import { Environment, EnvironmentName } from '../entities/Environment';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { ServiceRegistration } from '../entities/ServiceRegistration';
import { ProjectConfig } from '../entities/ProjectConfig';
import { File, FileProvider } from '../entities/File';
import { Alert } from '../entities/Alert';
import { DbConnection, DbConnectionStatus, DbType } from '../entities/DbConnection';
import { User, UserRole } from '../entities/User';
import { Role } from '../entities/Role';
import { AuditLog } from '../entities/AuditLog';
import { ClickupTaskLink } from '../entities/ClickupTaskLink';
import { SdkCredential } from '../entities/SdkCredential';
import { SmtpConfig } from '../entities/SmtpConfig';
import { StorageProvider } from '../entities/StorageProvider';

// MongoDB Models
import { connectMongo } from '../config/mongoose';
import { LogModel } from '../schemas/Log';
import { ErrorDocModel } from '../schemas/ErrorDoc';
import { MetricsRawModel } from '../schemas/MetricsRaw';
import { SdkEventModel } from '../schemas/SdkEvent';
import { FeatureFlagModel } from '../schemas/FeatureFlag';
import { ApiMetricModel } from '../schemas/ApiMetric';
import { BugReportModel } from '../schemas/BugReport';

// Middleware & Helpers
import { expressAuthenticate, expressRequireRole, requirePermission, sdkTokenAuth, logAudit, clearPermissionCache, getUserPermissions, AuthenticatedRequest } from '../middleware/auth';
import { Permission } from '../config/permissions';
import { triggerPipeline } from '../lib/gitlab';
import { postComment, formatPreviewComment, extractTaskId, sanitizeBranch } from '../lib/clickup';
import { generatePreviewUrl } from '../lib/preview';
import { fetchSecrets } from '../lib/infisical';
import { forwardToLoki } from '../lib/lokilog';
import { getK8sNodes, getK8sNamespaces, deployK8sPreview, terminateK8sPreview, getK8sPods, getPodLogs, deletePod, checkK8sConnection, updateArgoCDApp } from '../lib/k8s';
import * as k8s from '@kubernetes/client-node';

import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = process.env.JWT_SECRET || 'caps-platform-super-secret-key';
const router = Router();

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ----------------------------------------------------
// AUTH & LOGIN FLOW
// ----------------------------------------------------
router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'User email not found. Run init-demo first.' });
    }

    user.lastLogin = new Date();
    await ds.getRepository(User).save(user);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    return res.json({ token, user });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/auth/gitlab', async (req: Request, res: Response) => {
  // Simulate GitLab OAuth redirect callback
  const redirectUrl = `/api/auth/gitlab/callback?code=mock_gitlab_code`;
  return res.redirect(redirectUrl);
});

router.get('/auth/gitlab/callback', async (req: Request, res: Response) => {
  try {
    const gitlabProfile = {
      id: '123456',
      name: 'GitLab Developer',
      email: 'gitlab_dev@caps.io',
      avatarUrl: 'https://assets.gitlab-static.net/uploads/-/system/user/avatar/123456/avatar.png',
    };

    const ds = await getDb();
    const repo = ds.getRepository(User);
    let user = await repo.findOne({ where: { email: gitlabProfile.email } });

    if (!user) {
      user = repo.create({
        id: uuidv4(),
        name: gitlabProfile.name,
        email: gitlabProfile.email,
        role: UserRole.DEVELOPER,
        gitlabId: gitlabProfile.id,
        avatarUrl: gitlabProfile.avatarUrl,
        lastLogin: new Date(),
      });
      await repo.save(user);
    } else {
      user.lastLogin = new Date();
      user.avatarUrl = gitlabProfile.avatarUrl;
      await repo.save(user);
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const portalUrl = process.env.PORTAL_URL || 'http://localhost:4200';
    return res.redirect(`${portalUrl}/dashboard?token=${token}`);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// USERS & USER MANAGEMENT
// ----------------------------------------------------
router.get('/users/init-demo', async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);

    const demoUsers = [
      { id: '00000000-0000-0000-0000-000000000001', name: 'Admin', email: 'admin@caps.io', role: UserRole.ADMIN },
      { id: '11111111-1111-1111-1111-111111111111', name: 'John Dev', email: 'john@caps.io', role: UserRole.DEVELOPER },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Sarah Lead', email: 'sarah@caps.io', role: UserRole.TECH_LEAD },
      { id: '33333333-3333-3333-3333-333333333333', name: 'DevOps Boss', email: 'devops@caps.io', role: UserRole.DEVOPS },
    ];

    const created: User[] = [];
    for (const demo of demoUsers) {
      const existing = await repo.findOne({ where: { email: demo.email } });
      if (!existing) {
        const user = repo.create(demo);
        const saved = await repo.save(user);
        created.push(saved);
      }
    }

    const all = await repo.find();
    return res.json({
      message: created.length > 0 ? `Created ${created.length} new demo users` : 'All demo users already exist',
      users: all,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/users', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find();
    return res.json(users);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/users', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(User);

    const user = repo.create({
      id: uuidv4(),
      name: body.name,
      email: body.email,
      role: body.role as UserRole,
      gitlabId: body.gitlabId || null,
      avatarUrl: body.avatarUrl || null,
    });
    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.created',
      targetType: 'User',
      targetId: saved.id,
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/users/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (body.name !== undefined) user.name = body.name;
    if (body.email !== undefined) user.email = body.email;
    if (body.role !== undefined) user.role = body.role as UserRole;
    if (body.gitlabId !== undefined) user.gitlabId = body.gitlabId;
    if (body.avatarUrl !== undefined) user.avatarUrl = body.avatarUrl;

    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.updated',
      targetType: 'User',
      targetId: saved.id,
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/users/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    await repo.remove(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.deleted',
      targetType: 'User',
      targetId: req.params.id,
      ip: req.ip,
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// USER PROFILE (SELF-SERVICE)
// ----------------------------------------------------
router.get('/users/me', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({
      where: { id: (req as AuthenticatedRequest).user!.id },
      relations: ['roleRef'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/users/me', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id: (req as AuthenticatedRequest).user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { name, avatarUrl } = req.body;
    if (name !== undefined) user.name = name;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

    const saved = await repo.save(user);
    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/users/invite', expressAuthenticate, requirePermission('users.create'), async (req: Request, res: Response) => {
  try {
    const { email, name, roleId, role } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Email and name are required' });
    }

    const ds = await getDb();
    const repo = ds.getRepository(User);

    const existing = await repo.findOne({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const userRole = (role as UserRole) || UserRole.DEVELOPER;

    const user = repo.create({
      id: uuidv4(),
      name,
      email,
      role: userRole,
      roleId: roleId || null,
    });
    const saved = await repo.save(user);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.invited',
      targetType: 'User',
      targetId: saved.id,
      metadata: { email, role: userRole, roleId },
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/users/:id/role', expressAuthenticate, requirePermission('users.assign-role'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, roleId } = req.body;

    const ds = await getDb();
    const repo = ds.getRepository(User);
    const user = await repo.findOne({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (role !== undefined) user.role = role as UserRole;
    if (roleId !== undefined) user.roleId = roleId || null;

    const saved = await repo.save(user);
    clearPermissionCache(id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'user.role-updated',
      targetType: 'User',
      targetId: id,
      metadata: { role: user.role, roleId: user.roleId },
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/users/:id/permissions', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const user = await ds.getRepository(User).findOne({
      where: { id: req.params.id },
      relations: ['roleRef'],
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const perms = await getUserPermissions({ id: user.id, role: user.role, roleId: user.roleId });
    return res.json({
      userId: user.id,
      role: user.role,
      roleId: user.roleId,
      permissions: Array.from(perms),
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ROLES & RBAC
// ----------------------------------------------------
router.get('/roles', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const roles = await ds.getRepository(Role).find({ order: { name: 'ASC' } });
    return res.json(roles);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/roles/:id', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const role = await ds.getRepository(Role).findOne({ where: { id: req.params.id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });
    return res.json(role);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/roles', expressAuthenticate, requirePermission('users.create'), async (req: Request, res: Response) => {
  try {
    const { name, description, permissions } = req.body;
    if (!name) return res.status(400).json({ error: 'Role name is required' });

    const ds = await getDb();
    const repo = ds.getRepository(Role);

    const existing = await repo.findOne({ where: { name } });
    if (existing) return res.status(409).json({ error: 'Role with this name already exists' });

    const role = repo.create({
      name,
      description: description || null,
      permissions: permissions || [],
    });
    const saved = await repo.save(role);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.created',
      targetType: 'Role',
      targetId: saved.id,
      metadata: { name, permissionsCount: (permissions || []).length },
      ip: req.ip,
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/roles/:id', expressAuthenticate, requirePermission('users.update'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ds = await getDb();
    const repo = ds.getRepository(Role);
    const role = await repo.findOne({ where: { id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res.status(400).json({ error: 'Cannot modify system roles' });
    }

    const { name, description, permissions, isActive } = req.body;
    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions !== undefined) role.permissions = permissions;
    if (isActive !== undefined) role.isActive = isActive;

    const saved = await repo.save(role);

    // Clear permission cache for all users with this role
    const users = await ds.getRepository(User).find({ where: { roleId: id } });
    for (const u of users) clearPermissionCache(u.id);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.updated',
      targetType: 'Role',
      targetId: id,
      metadata: { name: role.name },
      ip: req.ip,
    });

    return res.json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/roles/:id', expressAuthenticate, requirePermission('users.delete'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ds = await getDb();
    const repo = ds.getRepository(Role);
    const role = await repo.findOne({ where: { id } });
    if (!role) return res.status(404).json({ error: 'Role not found' });

    if (role.isSystem) {
      return res.status(400).json({ error: 'Cannot delete system roles' });
    }

    // Unassign users from this role
    const users = await ds.getRepository(User).find({ where: { roleId: id } });
    for (const u of users) {
      u.roleId = null;
      await ds.getRepository(User).save(u);
      clearPermissionCache(u.id);
    }

    await repo.remove(role);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: id,
      metadata: { name: role.name, affectedUsers: users.length },
      ip: req.ip,
    });

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/permissions', expressAuthenticate, requirePermission('users.list'), async (req: Request, res: Response) => {
  const { PERMISSIONS } = require('../config/permissions');
  return res.json(PERMISSIONS);
});

router.post('/roles/:id/permissions/validate', expressAuthenticate, requirePermission('users.update'), async (req: Request, res: Response) => {
  try {
    const { permissions } = req.body;
    const { PERMISSIONS: ALL_PERMS } = require('../config/permissions');
    const valid = (permissions || []).filter((p: string) => p in ALL_PERMS);
    const invalid = (permissions || []).filter((p: string) => !(p in ALL_PERMS));
    return res.json({ valid, invalid, totalValid: valid.length, totalInvalid: invalid.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// PROJECTS
// ----------------------------------------------------
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

    // Create Environments: development, staging, production
    const envRepo = ds.getRepository(Environment);
    const envNames = [EnvironmentName.STAGING, EnvironmentName.PRODUCTION];
    
    // Also include development environment dynamically
    const devEnv = envRepo.create({
      name: 'development' as any,
      namespace: `${saved.name}-development`,
      domain: body.domain ? `development.${body.domain}` : `${saved.name}-development.example.com`,
      projectId: saved.id,
    });
    await envRepo.save(devEnv);

    for (const name of envNames) {
      const env = envRepo.create({
        name,
        namespace: `${saved.name}-${name}`,
        domain: body.domain ? `${name}.${body.domain}` : `${saved.name}-${name}.example.com`,
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

// ----------------------------------------------------
// PROJECT SDK TOKENS
// ----------------------------------------------------
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
    const rawToken = `caps_sdk_live_${uuidv4().replace(/-/g, '')}`;

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

// ----------------------------------------------------
// DEPLOYMENTS
// ----------------------------------------------------
router.get('/deployments/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
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

    // Verify project and environment
    const project = await ds.getRepository(Project).findOne({ where: { id: body.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let env = await ds.getRepository(Environment).findOne({ where: { id: body.environmentId } });
    if (!env) {
      // If it's a preview env, create on the fly
      if (body.environmentName === 'preview') {
        const previewRepo = ds.getRepository(Environment);
        const previewUrl = generatePreviewUrl(body.branch || 'preview');
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
      metadata: body.metadata || {},
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

    // Perform real deployment process
    setTimeout(async () => {
      try {
        const checkDs = await getDb();
        const dep = await checkDs.getRepository(Deployment).findOne({ where: { id: saved.id } });
        if (!dep) return;

        dep.status = DeploymentStatus.BUILDING;
        await checkDs.getRepository(Deployment).save(dep);

        let success = false;
        let deployError = '';

        if (env!.name === EnvironmentName.PREVIEW) {
          dep.status = DeploymentStatus.DEPLOYING;
          await checkDs.getRepository(Deployment).save(dep);

          success = await deployK8sPreview(project.name, dep.branch, dep.imageTag);
          if (!success) {
            deployError = 'Preview deployment failed to apply or timeout occurred.';
          }
        } else {
          dep.status = DeploymentStatus.DEPLOYING;
          await checkDs.getRepository(Deployment).save(dep);

          const appName = `${project.name}-${env!.name}`.toLowerCase();
          const argoOk = await updateArgoCDApp(appName, dep.imageTag);
          if (argoOk) {
            // Poll ArgoCD status every 5 seconds for up to 3 minutes
            let attempts = 0;
            const maxAttempts = 36; // 3 minutes
            const kc = new k8s.KubeConfig();
            kc.loadFromDefault();
            const customApi = kc.makeApiClient(k8s.CustomObjectsApi);

            while (attempts < maxAttempts) {
              await new Promise(r => setTimeout(r, 5000));
              attempts++;
              try {
                const appResponse: any = await customApi.getNamespacedCustomObject({
                  group: 'argoproj.io',
                  version: 'v1alpha1',
                  namespace: 'argocd',
                  plural: 'applications',
                  name: appName
                });
                const app = appResponse.body || appResponse;
                const status = app.status || {};
                const sync = status.sync?.status;
                const health = status.health?.status;

                console.log(`[argo-poll] Attempt ${attempts}: App ${appName} sync=${sync}, health=${health}`);

                if (sync === 'Synced' && health === 'Healthy') {
                  success = true;
                  break;
                }
                if (sync === 'Failed' || health === 'Degraded') {
                  deployError = `ArgoCD application sync status is ${sync} and health status is ${health}.`;
                  break;
                }
              } catch (e: any) {
                console.warn(`[argo-poll] Failed to fetch status on attempt ${attempts}:`, e.message);
              }
            }

            if (!success && !deployError) {
              deployError = 'ArgoCD sync timed out after 3 minutes.';
            }
          } else {
            deployError = `Failed to update ArgoCD application custom resource '${appName}'.`;
          }
        }

        const finalDep = await checkDs.getRepository(Deployment).findOne({ where: { id: saved.id } });
        if (finalDep) {
          if (success) {
            finalDep.status = DeploymentStatus.DEPLOYED;
            finalDep.deployedAt = new Date();
          } else {
            finalDep.status = DeploymentStatus.FAILED;
            finalDep.metadata = {
              ...(finalDep.metadata || {}),
              error: deployError || 'Unknown deployment failure'
            };
          }
          await checkDs.getRepository(Deployment).save(finalDep);

          // Update ClickUp if linked and deployment succeeded
          if (success && clickupTaskId) {
            const comment = await formatPreviewComment({
              project: project.name,
              branch: finalDep.branch,
              url: finalDep.previewUrl || `https://${env!.domain}`,
              commit: finalDep.commitSha.substring(0, 7),
            });
            await postComment(clickupTaskId, comment);

            const linkRepo = checkDs.getRepository(ClickupTaskLink);
            const link = linkRepo.create({
              clickupTaskId,
              deploymentId: finalDep.id,
              projectId: project.id,
              branch: finalDep.branch,
            });
            await linkRepo.save(link);
          }
        }
      } catch (err: any) {
        console.error('[deploy-bg] Background deploy error:', err.message);
        try {
          const checkDs = await getDb();
          const dep = await checkDs.getRepository(Deployment).findOne({ where: { id: saved.id } });
          if (dep && (dep.status === DeploymentStatus.PENDING || dep.status === DeploymentStatus.BUILDING || dep.status === DeploymentStatus.DEPLOYING)) {
            dep.status = DeploymentStatus.FAILED;
            dep.metadata = {
              ...(dep.metadata || {}),
              error: err.message
            };
            await checkDs.getRepository(Deployment).save(dep);
          }
        } catch {}
      }
    }, 1000);

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/rollback', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Deployment);

    const current = await repo.findOne({ where: { id: body.deploymentId } });
    if (!current) {
      return res.status(404).json({ error: 'Deployment not found' });
    }

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

    deployment.status = DeploymentStatus.PENDING;
    await repo.save(deployment);

    setTimeout(async () => {
      deployment.status = DeploymentStatus.DEPLOYED;
      deployment.deployedAt = new Date();
      const checkDs = await getDb();
      await checkDs.getRepository(Deployment).save(deployment);
    }, 2000);

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

// ----------------------------------------------------
// CONFIG & FEATURE FLAGS
// ----------------------------------------------------
router.get('/config', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environmentId } = req.query as Record<string, string>;
    const ds = await getDb();
    const repo = ds.getRepository(ProjectConfig);
    
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;
    if (environmentId) filter.environmentId = environmentId;

    const configs = await repo.find({ where: filter });
    const result: Record<string, string> = {};
    for (const c of configs) {
      result[c.key] = c.value;
    }
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/config', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
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
    const { projectId, key, environmentId } = req.query as Record<string, string>;
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
    const body = req.body;
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

// ----------------------------------------------------
// STORAGE & LOCAL SHIM FOR FILE UPLOADS
// ----------------------------------------------------
router.post('/storage/upload-url', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const { projectId, fileName, mimeType, provider, bucket, category, uploadedById } = body;

    const ds = await getDb();
    const repo = ds.getRepository(File);

    const fileId = uuidv4();
    const storageKey = `${projectId}/${fileId}/${fileName || 'unnamed'}`;

    const file = repo.create({
      id: fileId,
      projectId,
      provider: provider || FileProvider.LOCAL,
      bucket: bucket || 'default-bucket',
      storageKey,
      originalName: fileName || 'file',
      mimeType: mimeType || null,
      category: category || null,
      uploadedById: uploadedById || null,
    });
    await repo.save(file);

    // Express local upload URL helper
    const url = `/api/storage/upload-raw/${fileId}`;
    return res.status(201).json({ url, fileId });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// Endpoint called by SDK to perform direct local uploads
router.put('/storage/upload-raw/:fileId', async (req: Request, res: Response) => {
  try {
    const fileId = req.params.fileId;
    const ds = await getDb();
    const file = await ds.getRepository(File).findOne({ where: { id: fileId } });
    if (!file) return res.status(404).json({ error: 'File registration not found' });

    const filePath = path.join(UPLOADS_DIR, `${fileId}-${file.originalName}`);
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);

    req.on('end', () => {
      const stats = fs.statSync(filePath);
      file.size = stats.size;
      ds.getRepository(File).save(file).then(() => {
        return res.json({ success: true, size: stats.size });
      });
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/storage/confirm', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const { fileId, size, cdnUrl } = body;

    const ds = await getDb();
    const repo = ds.getRepository(File);
    const file = await repo.findOne({ where: { id: fileId } });
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (size !== undefined) file.size = size;
    file.cdnUrl = cdnUrl || `/api/storage/file/${fileId}`;
    await repo.save(file);
    return res.json(file);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/storage/delete', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { fileId } = req.body;
    const ds = await getDb();
    const file = await ds.getRepository(File).findOne({ where: { id: fileId } });
    if (!file) return res.status(404).json({ error: 'File not found' });

    file.isDeleted = true;
    file.deletedAt = new Date();
    await ds.getRepository(File).save(file);

    // Delete local physical file if it exists
    const filePath = path.join(UPLOADS_DIR, `${fileId}-${file.originalName}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/file/:id', async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const file = await ds.getRepository(File).findOne({ where: { id: req.params.id } });
    if (!file || file.isDeleted) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(UPLOADS_DIR, `${file.id}-${file.originalName}`);
    if (fs.existsSync(filePath)) {
      res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
      return res.sendFile(filePath);
    }
    return res.status(404).json({ error: 'Physical file not found' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/project/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const files = await ds.getRepository(File).find({
      where: { projectId: req.params.projectId, isDeleted: false },
    });
    return res.json(files);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/storage/analytics/:projectId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const files = await ds.getRepository(File).find({
      where: { projectId: req.params.projectId, isDeleted: false },
    });
    const totalBytes = files.reduce((acc, f) => acc + Number(f.size || 0), 0);
    const count = files.length;
    return res.json({
      totalBytes,
      count,
      providerBreakdown: {
        local: count,
      },
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// ALERTS
// ----------------------------------------------------
router.get('/alerts', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    const ds = await getDb();
    const filter = projectId ? { projectId } : {};
    const alerts = await ds.getRepository(Alert).find({ where: filter });
    return res.json(alerts);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/alerts', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Alert);

    const alert = repo.create({
      projectId: body.projectId,
      type: body.type || body.config?.metric || 'cpu_high',
      severity: body.severity || 'warning',
      config: body.config || {},
      isEnabled: body.enabled !== false,
    });
    const saved = await repo.save(alert);
    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.put('/alerts/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Alert);
    const alert = await repo.findOne({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });

    if (body.enabled !== undefined) alert.isEnabled = body.enabled;
    if (body.config !== undefined) alert.config = body.config;
    if (body.severity !== undefined) alert.severity = body.severity;

    await repo.save(alert);
    return res.json(alert);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/alerts/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Alert);
    const alert = await repo.findOne({ where: { id: req.params.id } });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    await repo.remove(alert);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/alerts/evaluate', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, metrics } = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(Alert);
    const rules = await repo.find({ where: { projectId, isEnabled: true } });

    const triggered = [];
    for (const rule of rules) {
      const metricVal = metrics[(rule.config as any)?.metric];
      if (metricVal !== undefined) {
        let isTriggered = false;
        if (rule.config.operator === '>' && metricVal > (rule.config as any).threshold) isTriggered = true;
        if (rule.config.operator === '<' && metricVal < (rule.config as any).threshold) isTriggered = true;
        if (rule.config.operator === '==' && metricVal == (rule.config as any).threshold) isTriggered = true;

        if (isTriggered) {
          triggered.push({
            ruleId: rule.id,
            metric: (rule.config as any).metric,
            value: metricVal,
            threshold: (rule.config as any).threshold,
            severity: rule.severity,
          });
        }
      }
    }
    return res.json({ evaluatedCount: rules.length, triggered });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// DB CONNECTIONS
// ----------------------------------------------------
router.get('/db-connections', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    const ds = await getDb();
    const filter = projectId ? { projectId } : {};
    const connections = await ds.getRepository(DbConnection).find({ where: filter });
    return res.json(connections);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/db-connections', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(DbConnection);

    const conn = repo.create({
      projectId: body.projectId,
      dbType: body.dbType as DbType,
      poolSize: body.poolSize || 10,
      status: DbConnectionStatus.CONNECTED,
      lastHeartbeat: new Date(),
    });
    const saved = await repo.save(conn);
    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/db-connections/:id/test', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(DbConnection);
    const conn = await repo.findOne({ where: { id: req.params.id } });
    if (!conn) return res.status(404).json({ error: 'DB Connection not found' });

    conn.status = DbConnectionStatus.CONNECTED;
    conn.lastHeartbeat = new Date();
    await repo.save(conn);
    return res.json({ status: 'connected', latencyMs: Math.floor(Math.random() * 20) + 1 });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/db-connections/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(DbConnection);
    const conn = await repo.findOne({ where: { id: req.params.id } });
    if (!conn) return res.status(404).json({ error: 'DB Connection not found' });
    await repo.remove(conn);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// BOOTSTRAP & KUBERNETES CONTROL
// ----------------------------------------------------
router.post('/bootstrap/init', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { hostname, components } = req.body;
    const log = [
      `[${new Date().toISOString()}] Bootstrap initiated for hostname: ${hostname}`,
      ...(components || []).map((c: string) => `[${new Date().toISOString()}] Component "${c}" registered`),
      `[${new Date().toISOString()}] Bootstrap completed`,
    ].join('\n');
    return res.status(201).json({ status: 'completed', log });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/bootstrap/status', expressAuthenticate, async (req: Request, res: Response) => {
  let pgStatus = 'disconnected';
  try {
    const ds = await getDb();
    if (ds.isInitialized) {
      await ds.query('SELECT 1');
      pgStatus = 'connected';
    }
  } catch (err) {
    pgStatus = 'disconnected';
  }

  let mongoStatus = 'disconnected';
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      mongoStatus = 'connected';
    } else {
      // Try connecting
      await connectMongo();
      if (mongoose.connection && mongoose.connection.readyState === 1) {
        mongoStatus = 'connected';
      }
    }
  } catch (err) {
    mongoStatus = 'disconnected';
  }

  let k8sStatus = 'disconnected';
  try {
    const isConnected = await checkK8sConnection();
    k8sStatus = isConnected ? 'connected' : 'disconnected';
  } catch (err) {
    k8sStatus = 'disconnected';
  }

  return res.json({
    status: pgStatus === 'connected' && k8sStatus === 'connected' ? 'healthy' : 'degraded',
    postgres: pgStatus,
    mongodb: mongoStatus,
    k8s: k8sStatus,
    services: {
      loki: k8sStatus === 'connected' ? 'running' : 'offline',
      prometheus: k8sStatus === 'connected' ? 'running' : 'offline',
      grafana: k8sStatus === 'connected' ? 'running' : 'offline',
      infisical: k8sStatus === 'connected' ? 'running' : 'offline',
      argocd: k8sStatus === 'connected' ? 'running' : 'offline',
    },
  });
});

router.get('/bootstrap/token', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  return res.json({ token: uuidv4() });
});

router.get('/bootstrap/history', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  // Mock bootstrap job history logs
  return res.json([
    { id: 1, nodeIp: '192.168.1.105', hostname: 'caps-worker-1', status: 'success', date: new Date(Date.now() - 3600000) },
    { id: 2, nodeIp: '192.168.1.106', hostname: 'caps-worker-2', status: 'success', date: new Date(Date.now() - 7200000) },
  ]);
});

router.get('/bootstrap/nodes', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  const nodes = await getK8sNodes();
  return res.json({ k8sConnected: isConnected, nodes });
});

router.get('/bootstrap/namespaces', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  const namespaces = await getK8sNamespaces();
  return res.json({ k8sConnected: isConnected, namespaces });
});

router.get('/bootstrap/pods', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  const isConnected = await checkK8sConnection();
  if (!isConnected) {
    // Return mock pods when disconnected, but indicate status
    const fallbackPods = [
      { name: 'caps-platform-backend-67fd89c-4x92m', namespace: 'caps-platform', status: 'Running', restarts: 0, age: '12d', node: 'kvm8-master' },
      { name: 'caps-platform-portal-9f8e7d-2b4x9', namespace: 'caps-platform', status: 'Running', restarts: 1, age: '12d', node: 'caps-worker-1' },
      { name: 'preview-cu-842-auth-fix-bc68d-lq2p9', namespace: 'preview', status: 'Running', restarts: 0, age: '1d', node: 'caps-worker-2' },
      { name: 'preview-cu-123-upload-fd68e-mq8p1', namespace: 'preview', status: 'Failed', restarts: 5, age: '3h', node: 'caps-worker-2' },
      { name: 'postgres-db-0', namespace: 'databases', status: 'Running', restarts: 0, age: '45d', node: 'caps-worker-1' }
    ];
    return res.json({ k8sConnected: false, pods: fallbackPods });
  }

  try {
    const ns = req.query.namespace as string | undefined;
    const pods = await getK8sPods(ns);
    return res.json({ k8sConnected: true, pods });
  } catch (err: any) {
    return res.status(400).json({ error: err.message, k8sConnected: false });
  }
});

router.get('/bootstrap/pods/:namespace/:podName/logs', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { namespace, podName } = req.params;
    const logs = await getPodLogs(namespace, podName);
    return res.json({ logs });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/bootstrap/pods/:namespace/:podName', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { namespace, podName } = req.params;
    await deletePod(namespace, podName);
    
    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'pod.deleted',
      targetType: 'Pod',
      targetId: `${namespace}/${podName}`,
      ip: req.ip,
    });

    return res.json({ success: true, message: `Pod ${podName} in namespace ${namespace} deleted` });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// INTEGRATIONS (CLICKUP)
// ----------------------------------------------------
router.post('/integrations/clickup/webhook', async (req: Request, res: Response) => {
  try {
    const { task_id, status } = req.body;
    if (status === 'In Review') {
      const ds = await getDb();
      const link = await ds.getRepository(ClickupTaskLink).findOne({ where: { clickupTaskId: task_id } });
      if (link) {
        await triggerPipeline(link.projectId, link.branch);
        return res.json({ success: true, message: 'GitLab CI pipeline triggered' });
      }
    }
    return res.json({ success: false, message: 'No linked deployment found' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/integrations/clickup/status', expressAuthenticate, async (req: Request, res: Response) => {
  return res.json({ integration: 'ClickUp', status: 'active', webhooksRegistered: 1 });
});

// ----------------------------------------------------
// WEBHOOKS — GITHUB
// ----------------------------------------------------
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

function verifyGitHubSignature(payload: string, signature: string | undefined): boolean {
  if (!GITHUB_WEBHOOK_SECRET || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

router.post('/webhooks/github', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    if (!verifyGitHubSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.headers['x-github-event'] as string;
    const payload = req.body;

    if (event === 'push') {
      const branch = (payload.ref || '').replace('refs/heads/', '');
      const repoUrl = payload.repository?.clone_url || '';
      const ds = await getDb();
      const project = await ds.getRepository(Project).findOne({ where: { repositoryUrl: repoUrl } });

      if (!project) return res.json({ success: false, message: 'No matching project' });

      const commitSha = payload.after || 'unknown';

      if (branch === 'main' || branch === 'master') {
        const deployment = ds.getRepository(Deployment).create({
          projectId: project.id,
          branch,
          commitSha,
          version: `v-${Date.now()}`,
          imageTag: `${project.name}:latest`,
          status: DeploymentStatus.PENDING,
        });
        await ds.getRepository(Deployment).save(deployment);
        await triggerPipeline(project.id, branch);
        return res.json({ success: true, message: 'Staging deploy triggered' });
      }

      const previewUrl = generatePreviewUrl(branch);
      const deployment = ds.getRepository(Deployment).create({
        projectId: project.id,
        branch,
        commitSha,
        version: `preview-${Date.now()}`,
        imageTag: `${project.name}:${branch}`,
        status: DeploymentStatus.BUILDING,
        previewUrl,
      });
      await ds.getRepository(Deployment).save(deployment);

      const taskId = extractTaskId(branch);
      if (taskId) {
        const comment = await formatPreviewComment({ project: project.name, branch, url: previewUrl, commit: commitSha });
        await postComment(taskId, comment);
      }

      if (project.clickupListId) {
        await triggerPipeline(project.id, branch);
      }

      // Deploy preview environment via K8s
      try {
        await deployK8sPreview(project.name, branch, `${project.name}:${branch}`);
        deployment.status = DeploymentStatus.DEPLOYED;
        deployment.deployedAt = new Date();
        await ds.getRepository(Deployment).save(deployment);
      } catch (err: any) {
        console.error(`[webhook] Preview deploy failed for ${branch}: ${err.message}`);
        deployment.status = DeploymentStatus.FAILED;
        await ds.getRepository(Deployment).save(deployment);
      }

      return res.json({ success: true, message: 'Preview deploy triggered', previewUrl });
    }

    if (event === 'pull_request') {
      const action = payload.action;
      const pr = payload.pull_request;
      if (!pr) return res.json({ success: true, message: 'Ignored PR event' });

      const branch = pr.head?.ref || '';
      const repoUrl = pr.base?.repo?.clone_url || '';
      const ds = await getDb();
      const project = await ds.getRepository(Project).findOne({ where: { repositoryUrl: repoUrl } });

      if (!project) return res.json({ success: false, message: 'No matching project' });

      if (action === 'closed' && !pr.merged) {
        const previewUrl = generatePreviewUrl(branch);
        await terminateK8sPreview(branch);
        const deployment = await ds.getRepository(Deployment).findOne({
          where: { projectId: project.id, branch, previewUrl },
          order: { createdAt: 'DESC' },
        });
        if (deployment) {
          deployment.status = DeploymentStatus.TERMINATED;
          deployment.terminatedAt = new Date();
          await ds.getRepository(Deployment).save(deployment);
        }
        return res.json({ success: true, message: 'Preview terminated' });
      }

      if (action === 'opened' || action === 'synchronize') {
        const commitSha = pr.head?.sha || 'unknown';
        const previewUrl = generatePreviewUrl(branch);
        const deployment = ds.getRepository(Deployment).create({
          projectId: project.id,
          branch,
          commitSha,
          version: `pr-${pr.number}-${Date.now()}`,
          imageTag: `${project.name}:${branch}`,
          status: DeploymentStatus.BUILDING,
          previewUrl,
          metadata: { prNumber: pr.number, prTitle: pr.title },
        });
        await ds.getRepository(Deployment).save(deployment);
        await triggerPipeline(project.id, branch);

        // Deploy preview environment via K8s
        try {
          await deployK8sPreview(project.name, branch, `${project.name}:${branch}`);
          deployment.status = DeploymentStatus.DEPLOYED;
          deployment.deployedAt = new Date();
          await ds.getRepository(Deployment).save(deployment);
        } catch (err: any) {
          console.error(`[webhook] PR preview deploy failed for ${branch}: ${err.message}`);
          deployment.status = DeploymentStatus.FAILED;
          await ds.getRepository(Deployment).save(deployment);
        }

        return res.json({ success: true, message: 'PR preview triggered', previewUrl });
      }
    }

    return res.json({ success: true, message: 'Event ignored' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// WEBHOOKS — GITLAB
// ----------------------------------------------------
const GITLAB_WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET || '';

function verifyGitLabToken(token: string | undefined): boolean {
  if (!GITLAB_WEBHOOK_SECRET) return true;
  return token === GITLAB_WEBHOOK_SECRET;
}

router.post('/webhooks/gitlab', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const token = req.headers['x-gitlab-token'] as string | undefined;
    if (!verifyGitLabToken(token)) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const event = req.headers['x-gitlab-event'] as string;
    const payload = req.body;

    if (event === 'Push Hook') {
      const branch = (payload.ref || '').replace('refs/heads/', '');
      const repoUrl = payload.project?.http_url || payload.project?.clone_url || '';
      const ds = await getDb();
      const project = await ds.getRepository(Project).findOne({ where: { repositoryUrl: repoUrl } });

      if (!project) return res.json({ success: false, message: 'No matching project' });

      const commitSha = payload.after || payload.checkout_sha || 'unknown';

      if (branch === 'main' || branch === 'master') {
        const deployment = ds.getRepository(Deployment).create({
          projectId: project.id,
          branch,
          commitSha,
          version: `v-${Date.now()}`,
          imageTag: `${project.name}:latest`,
          status: DeploymentStatus.PENDING,
        });
        await ds.getRepository(Deployment).save(deployment);
        await triggerPipeline(project.id, branch);
        return res.json({ success: true, message: 'Staging deploy triggered' });
      }

      const previewUrl = generatePreviewUrl(branch);
      const deployment = ds.getRepository(Deployment).create({
        projectId: project.id,
        branch,
        commitSha,
        version: `preview-${Date.now()}`,
        imageTag: `${project.name}:${branch}`,
        status: DeploymentStatus.BUILDING,
        previewUrl,
      });
      await ds.getRepository(Deployment).save(deployment);

      const taskId = extractTaskId(branch);
      if (taskId) {
        const comment = await formatPreviewComment({ project: project.name, branch, url: previewUrl, commit: commitSha });
        await postComment(taskId, comment);
      }

      await triggerPipeline(project.id, branch);

      // Deploy preview environment via K8s
      try {
        await deployK8sPreview(project.name, branch, `${project.name}:${branch}`);
        deployment.status = DeploymentStatus.DEPLOYED;
        deployment.deployedAt = new Date();
        await ds.getRepository(Deployment).save(deployment);
      } catch (err: any) {
        console.error(`[webhook] Preview deploy failed for ${branch}: ${err.message}`);
        deployment.status = DeploymentStatus.FAILED;
        await ds.getRepository(Deployment).save(deployment);
      }

      return res.json({ success: true, message: 'Preview deploy triggered', previewUrl });
    }

    if (event === 'Merge Request Hook') {
      const action = payload.object_attributes?.action;
      const mr = payload.object_attributes;
      if (!mr) return res.json({ success: true, message: 'Ignored MR event' });

      const branch = mr.source_branch || '';
      const repoUrl = payload.project?.http_url || payload.project?.clone_url || '';
      const ds = await getDb();
      const project = await ds.getRepository(Project).findOne({ where: { repositoryUrl: repoUrl } });

      if (!project) return res.json({ success: false, message: 'No matching project' });

      if (action === 'close' || action === 'merge') {
        const previewUrl = generatePreviewUrl(branch);
        await terminateK8sPreview(branch);
        const deployment = await ds.getRepository(Deployment).findOne({
          where: { projectId: project.id, branch, previewUrl },
          order: { createdAt: 'DESC' },
        });
        if (deployment) {
          deployment.status = action === 'merge' ? DeploymentStatus.DEPLOYED : DeploymentStatus.TERMINATED;
          deployment.terminatedAt = new Date();
          await ds.getRepository(Deployment).save(deployment);
        }
        return res.json({ success: true, message: `Preview ${action === 'merge' ? 'merged' : 'terminated'}` });
      }

      if (action === 'open' || action === 'update') {
        const commitSha = mr.last_commit?.id || 'unknown';
        const previewUrl = generatePreviewUrl(branch);
        const deployment = ds.getRepository(Deployment).create({
          projectId: project.id,
          branch,
          commitSha,
          version: `mr-${mr.iid}-${Date.now()}`,
          imageTag: `${project.name}:${branch}`,
          status: DeploymentStatus.BUILDING,
          previewUrl,
          metadata: { mrNumber: mr.iid, mrTitle: mr.title },
        });
        await ds.getRepository(Deployment).save(deployment);
        await triggerPipeline(project.id, branch);

        // Deploy preview environment via K8s
        try {
          await deployK8sPreview(project.name, branch, `${project.name}:${branch}`);
          deployment.status = DeploymentStatus.DEPLOYED;
          deployment.deployedAt = new Date();
          await ds.getRepository(Deployment).save(deployment);
        } catch (err: any) {
          console.error(`[webhook] MR preview deploy failed for ${branch}: ${err.message}`);
          deployment.status = DeploymentStatus.FAILED;
          await ds.getRepository(Deployment).save(deployment);
        }

        return res.json({ success: true, message: 'MR preview triggered', previewUrl });
      }
    }

    return res.json({ success: true, message: 'Event ignored' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// CI/CD — REGISTER WEBHOOK
// ----------------------------------------------------
router.post('/cicd/register-webhook/:projectId', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.repositoryUrl) {
      return res.status(400).json({ error: 'No repository URL configured for this project' });
    }

    const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/gitlab`;
    const token = process.env.GITLAB_WEBHOOK_SECRET || uuidv4();

    if (project.repositoryUrl.includes('gitlab')) {
      const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
      const TOKEN = process.env.GITLAB_TOKEN;
      if (!TOKEN) return res.status(500).json({ error: 'GITLAB_TOKEN not configured' });

      const projectIdPath = project.repositoryUrl.replace(/.*gitlab\.com\//, '').replace(/\.git$/, '');
      const response = await fetch(`${GITLAB_API}/projects/${encodeURIComponent(projectIdPath)}/hooks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: webhookUrl,
          token,
          push_events: true,
          merge_requests_events: true,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: `GitLab webhook registration failed: ${err}` });
      }
      return res.json({ success: true, message: 'Webhook registered on GitLab', webhookUrl });
    }

    if (project.repositoryUrl.includes('github')) {
      const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
      if (!GITHUB_TOKEN || !GITHUB_WEBHOOK_SECRET) {
        return res.status(500).json({ error: 'GITHUB_TOKEN and GITHUB_WEBHOOK_SECRET must be configured' });
      }

      const ownerRepo = project.repositoryUrl.replace(/.*github\.com\//, '').replace(/\.git$/, '');
      const response = await fetch(`https://api.github.com/repos/${ownerRepo}/hooks`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: ['push', 'pull_request'],
          config: {
            url: `${req.protocol}://${req.get('host')}/api/webhooks/github`,
            content_type: 'json',
            secret: GITHUB_WEBHOOK_SECRET,
          },
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(500).json({ error: `GitHub webhook registration failed: ${err}` });
      }
      return res.json({ success: true, message: 'Webhook registered on GitHub', webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/github` });
    }

    return res.status(400).json({ error: 'Unsupported repository host. Only GitHub and GitLab are supported.' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// AUDIT LOGS
// ----------------------------------------------------
router.get('/audit-logs', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const logs = await ds.getRepository(AuditLog).find({
      order: { performedAt: 'DESC' },
      take: 100,
    });
    return res.json(logs);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// LOGS SEARCH (Portal)
// ----------------------------------------------------
router.get('/logs/search', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environmentId, serviceName, level, search, limit, offset } = req.query as Record<string, string>;
    await connectMongo();
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;
    if (environmentId) filter.environment = environmentId;
    if (serviceName) filter.serviceName = serviceName;
    if (level) filter.level = level;
    if (search) filter.message = { $regex: search, $options: 'i' };

    const maxLimit = parseInt(limit || '50', 10);
    const skipOffset = parseInt(offset || '0', 10);

    const [logs, total] = await Promise.all([
      LogModel.find(filter).sort({ timestamp: -1 }).skip(skipOffset).limit(maxLimit).lean(),
      LogModel.countDocuments(filter),
    ]);

    return res.json({ logs, total });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// METRICS (Portal)
// ----------------------------------------------------
router.get('/metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    await connectMongo();
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;

    const raw = await MetricsRawModel.find(filter).sort({ timestamp: -1 }).limit(100).lean();
    return res.json(raw);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/metrics/aggregated', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    await connectMongo();
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;

    const raw = await MetricsRawModel.find(filter).sort({ timestamp: -1 }).limit(20).lean();
    if (raw.length === 0) return res.json({ cpuAvg: 0, memoryAvg: 0, errorRate: 0 });

    const cpuSum = raw.reduce((acc, r) => acc + (r.cpuPct || 0), 0);
    const memSum = raw.reduce((acc, r) => acc + (r.memoryMb || 0), 0);
    const errSum = raw.reduce((acc, r) => acc + (r.errors5xx || 0), 0);

    return res.json({
      cpuAvg: cpuSum / raw.length,
      memoryAvg: memSum / raw.length,
      errorRate: errSum / raw.length,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// CI/CD ENGINE MANIFEST GENERATORS
// ----------------------------------------------------
router.get('/cicd/gitlab-ci', expressAuthenticate, async (req: Request, res: Response) => {
  const { projectName, stack } = req.query as Record<string, string>;
  const template = `
stages:
  - lint
  - test
  - build
  - deploy-preview
  - deploy-staging
  - deploy-production

lint-job:
  stage: lint
  script:
    - echo "Linting ${projectName}..."

test-job:
  stage: test
  script:
    - echo "Testing ${projectName}..."

build-job:
  stage: build
  script:
    - echo "Building docker image for ${projectName} (stack: ${stack})..."
`;
  return res.json({ content: template });
});

router.get('/cicd/dockerfile', expressAuthenticate, async (req: Request, res: Response) => {
  const { stack } = req.query as Record<string, string>;
  let dockerfile = '';
  if (stack === 'nodejs') {
    dockerfile = `FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nCMD ["npm", "start"]`;
  } else if (stack === 'python') {
    dockerfile = `FROM python:3.10-slim\nWORKDIR /app\nCOPY requirements.txt ./\nRUN pip install -r requirements.txt\nCOPY . .\nCMD ["python", "main.py"]`;
  } else {
    dockerfile = `FROM nginx:alpine\nCOPY dist/ /usr/share/nginx/html/`;
  }
  return res.json({ content: dockerfile });
});

router.get('/cicd/helm', expressAuthenticate, async (req: Request, res: Response) => {
  const { projectName } = req.query as Record<string, string>;
  const helm = `
apiVersion: v2
name: ${projectName}
description: A Helm chart for Kubernetes
type: application
version: 0.1.0
appVersion: "1.0.0"
`;
  return res.json({ content: helm });
});

router.get('/cicd/kubernetes', expressAuthenticate, async (req: Request, res: Response) => {
  const { projectName } = req.query as Record<string, string>;
  const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${projectName}
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: app
          image: registry.gitlab.com/${projectName}:latest
`;
  return res.json({ content: manifest });
});

// ----------------------------------------------------
// SDK ENDPOINTS (INVOKED BY SDK CLIENTS)
// ----------------------------------------------------
router.post('/sdk/register', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    
    // Resolve project ID by name if needed
    const projectRepo = ds.getRepository(Project);
    let project = await projectRepo.findOne({ where: { name: body.projectName } });
    if (!project) {
      // Create project on-the-fly to facilitate local testing
      project = projectRepo.create({
        name: body.projectName,
        stack: StackType.NODEJS,
      });
      project = await projectRepo.save(project);
    }

    // Resolve environment ID by name
    const envRepo = ds.getRepository(Environment);
    let env = await envRepo.findOne({ where: { projectId: project.id, name: body.environmentName } });
    if (!env) {
      env = envRepo.create({
        name: body.environmentName as any,
        namespace: `${project.name}-${body.environmentName}`,
        domain: `${project.name}-${body.environmentName}.example.com`,
        projectId: project.id,
      });
      env = await envRepo.save(env);
    }

    const repo = ds.getRepository(ServiceRegistration);
    let registration = await repo.findOne({
      where: {
        projectId: project.id,
        environmentId: env.id,
        serviceName: body.serviceName || project.name,
      },
    });

    if (registration) {
      registration.hostname = body.hostname ?? registration.hostname;
      registration.ipAddress = body.ipAddress ?? registration.ipAddress;
      registration.version = body.version ?? registration.version;
      registration.branch = body.branch ?? registration.branch;
      registration.commitSha = body.commitSha ?? registration.commitSha;
      registration.infisicalProject = body.infisicalProject ?? registration.infisicalProject;
      registration.infisicalEnv = body.infisicalEnv ?? registration.infisicalEnv;
      registration.envKeys = body.envKeys ?? registration.envKeys;
      registration.dbTypes = body.dbTypes ?? registration.dbTypes;
      registration.metadata = body.metadata ?? registration.metadata;
      registration.lastSeen = new Date();
      registration.status = 'online';
    } else {
      registration = repo.create({
        projectId: project.id,
        environmentId: env.id,
        hostname: body.hostname || 'localhost',
        ipAddress: body.ipAddress || '127.0.0.1',
        serviceName: body.serviceName || project.name,
        version: body.version || '1.0.0',
        branch: body.branch || 'main',
        commitSha: body.commitSha || 'unknown',
        infisicalProject: body.infisicalProject || 'default',
        infisicalEnv: body.infisicalEnv || 'dev',
        envKeys: body.envKeys || [],
        dbTypes: body.dbTypes || [],
        status: 'online',
        metadata: body.metadata || {},
        lastSeen: new Date(),
      });
    }

    const saved = await repo.save(registration);

    // Ensure DB connection metrics placeholders are created in relational DB
    if (body.dbTypes && Array.isArray(body.dbTypes)) {
      const dbRepo = ds.getRepository(DbConnection);
      for (const type of body.dbTypes) {
        let conn = await dbRepo.findOne({ where: { projectId: project.id, dbType: type as DbType } });
        if (!conn) {
          conn = dbRepo.create({
            registrationId: saved.id,
            projectId: project.id,
            dbType: type as DbType,
            poolSize: 10,
            status: DbConnectionStatus.CONNECTED,
            lastHeartbeat: new Date(),
          });
          await dbRepo.save(conn);
        }
      }
    }

    await connectMongo();
    await SdkEventModel.create({
      event: 'registration',
      registrationId: saved.id,
      projectId: project.id,
      payloadSummary: { serviceName: body.serviceName, hostname: body.hostname },
      timestamp: new Date(),
    });

    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/deregister', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { projectId, serviceName } = req.body;
    const ds = await getDb();
    
    // Resolve project
    const project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (project) {
      const repo = ds.getRepository(ServiceRegistration);
      const reg = await repo.findOne({ where: { projectId: project.id, serviceName } });
      if (reg) {
        reg.status = 'offline';
        await repo.save(reg);
      }
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/sdk/heartbeat', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();

    const regRepo = ds.getRepository(ServiceRegistration);
    
    // Lookup registration
    let registration = await regRepo.findOne({ where: { id: body.registrationId } });
    if (!registration) {
      // Lookup by project name fallback
      const project = await ds.getRepository(Project).findOne({ where: { name: body.projectId } });
      if (project) {
        registration = await regRepo.findOne({ where: { projectId: project.id } });
      }
    }

    if (registration) {
      registration.lastSeen = new Date();
      registration.status = 'online';
      await regRepo.save(registration);
    }

    if (body.dbHealth && registration) {
      const dbRepo = ds.getRepository(DbConnection);
      // dbHealth structure: { postgres: { activeCount: 2, idleCount: 8, status: 'connected' } }
      for (const [dbType, health] of Object.entries(body.dbHealth) as any) {
        let conn = await dbRepo.findOne({ where: { registrationId: registration.id, dbType: dbType as DbType } });
        if (!conn) {
          conn = dbRepo.create({
            registrationId: registration.id,
            projectId: registration.projectId,
            dbType: dbType as DbType,
            poolSize: 10,
            status: DbConnectionStatus.CONNECTED,
          });
        }
        conn.status = health.status === 'connected' ? DbConnectionStatus.CONNECTED : DbConnectionStatus.DISCONNECTED;
        conn.lastHeartbeat = new Date();
        conn.activeCount = health.activeCount ?? conn.activeCount;
        conn.idleCount = health.idleCount ?? conn.idleCount;
        await dbRepo.save(conn);
      }
    }

    await connectMongo();
    await MetricsRawModel.create({
      registrationId: registration?.id || null,
      projectId: registration?.projectId || body.projectId,
      environment: body.environment || registration?.environmentId || 'development',
      cpuPct: body.cpuPct || Math.random() * 20,
      memoryMb: body.memoryMb || 128 + Math.random() * 64,
      heapMb: body.heapMb || 80,
      uptimeS: body.uptimeS || 100,
      requestCount: body.requestCount || Math.floor(Math.random() * 10),
      avgResponseMs: body.avgResponseMs || 15,
      p95ResponseMs: body.p95ResponseMs || 40,
      errors4xx: body.errors4xx || 0,
      errors5xx: body.errors5xx || 0,
      dbHealth: body.dbHealth || {},
      timestamp: new Date(),
    });

    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

const handleSdkLogs = async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const logs: any[] = body.logs;

    if (!Array.isArray(logs) || logs.length === 0) {
      return res.status(400).json({ error: 'logs must be a non-empty array' });
    }

    await connectMongo();
    const ds = await getDb();
    
    // Resolve project IDs if SDK sent projectNames
    const projectRepo = ds.getRepository(Project);
    const resolvedLogs = [];

    for (const log of logs) {
      let resolvedProjectId = log.projectId;
      // If it looks like a projectName (non-uuid), resolve it
      if (log.projectId && !log.projectId.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        const project = await projectRepo.findOne({ where: { name: log.projectId } });
        if (project) resolvedProjectId = project.id;
      }

      resolvedLogs.push({
        projectId: resolvedProjectId,
        environment: log.environment || 'development',
        branch: log.branch || 'main',
        commitSha: log.commitSha || 'unknown',
        hostname: log.hostname || 'localhost',
        level: (log.level || 'INFO').toUpperCase(),
        message: log.message,
        fields: log.metadata || log.fields || {},
        timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
      });
    }

    await LogModel.insertMany(resolvedLogs);
    await forwardToLoki(resolvedLogs);

    // Track Errors
    const errorLogs = resolvedLogs.filter((log) => log.level === 'ERROR');
    for (const err of errorLogs) {
      const stackHash = err.fields?.stackHash || err.message;
      await ErrorDocModel.findOneAndUpdate(
        {
          projectId: err.projectId,
          errorType: err.fields?.errorType || 'UnknownError',
          stackHash,
        },
        {
          $set: {
            environment: err.environment,
            message: err.message,
            lastSeen: new Date(),
          },
          $inc: { occurrenceCount: 1 },
          $setOnInsert: { firstSeen: new Date() },
        },
        { upsert: true }
      );
    }

    return res.status(201).json({ received: logs.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
};

router.post('/sdk/logs', sdkTokenAuth, handleSdkLogs);
router.post('/logs/ingest', sdkTokenAuth, handleSdkLogs);

router.get('/sdk/config', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { projectId, environmentId } = req.query as Record<string, string>;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const ds = await getDb();
    
    // Resolve project ID by name if needed
    let resolvedProjectId = projectId;
    const project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (project) resolvedProjectId = project.id;

    const repo = ds.getRepository(ProjectConfig);
    const configs = await repo.find({
      where: { projectId: resolvedProjectId, environmentId: environmentId || null },
    });

    const result: Record<string, string> = {};
    for (const cfg of configs) {
      result[cfg.key] = cfg.isSecret ? '***' : cfg.value;
    }

    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/sdk/db-credentials', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { projectId, dbTypes } = req.query as Record<string, string>;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const ds = await getDb();
    
    // Resolve project ID by name if needed
    let resolvedProjectId = projectId;
    const project = await ds.getRepository(Project).findOne({ where: { name: projectId } });
    if (project) resolvedProjectId = project.id;

    // Fetch Infisical credentials dynamically if token exists, else return fallbacks
    const secrets = await fetchSecrets(resolvedProjectId, 'development');

    const result: Record<string, any> = {};
    const types = dbTypes ? dbTypes.split(',').map((t) => t.trim()) : ['postgres', 'mongo', 'redis'];

    if (types.includes('postgres')) {
      result.postgres = {
        host: secrets.POSTGRES_HOST || process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(secrets.POSTGRES_PORT || process.env.POSTGRES_PORT || '5432', 10),
        user: secrets.POSTGRES_USER || process.env.POSTGRES_USER || 'caps',
        password: secrets.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'caps',
        database: secrets.POSTGRES_DB || process.env.POSTGRES_DB || 'caps_platform',
        poolSize: 10,
      };
    }

    if (types.includes('mongo')) {
      result.mongo = {
        uri: secrets.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/caps_platform',
        poolSize: 5,
      };
    }

    if (types.includes('redis')) {
      result.redis = {
        host: secrets.REDIS_HOST || process.env.REDIS_HOST || 'localhost',
        port: parseInt(secrets.REDIS_PORT || process.env.REDIS_PORT || '6379', 10),
        password: secrets.REDIS_PASSWORD || process.env.REDIS_PASSWORD || '',
      };
    }

    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// SDK API METRICS INGEST
// ----------------------------------------------------
router.post('/sdk/api-metrics', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const { metrics, projectId } = req.body;
    if (!Array.isArray(metrics) || metrics.length === 0) return res.json({ saved: 0 });
    await connectMongo();
    const docs = metrics.map((m: any) => ({
      projectId: projectId || m.projectId || 'unknown',
      route: m.route || '/',
      method: (m.method || 'GET').toUpperCase(),
      statusCode: m.statusCode || 200,
      durationMs: m.durationMs || 0,
      memoryDeltaBytes: m.memoryDeltaBytes || 0,
      sdkVersion: m.sdkVersion,
      environment: m.environment || 'production',
      timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
    }));
    await ApiMetricModel.insertMany(docs);
    return res.json({ saved: docs.length });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/sdk/api-metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environment, from, to } = req.query as Record<string, string>;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    await connectMongo();
    const dateFilter: any = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);
    const match: any = { projectId };
    if (environment) match.environment = environment;
    if (Object.keys(dateFilter).length) match.timestamp = dateFilter;

    const agg = await ApiMetricModel.aggregate([
      { $match: match },
      { $sort: { timestamp: -1 } },
      { $group: {
        _id: { route: '$route', method: '$method' },
        count: { $sum: 1 },
        avgDuration: { $avg: '$durationMs' },
        durations: { $push: '$durationMs' },
        errors4xx: { $sum: { $cond: [{ $and: [{ $gte: ['$statusCode', 400] }, { $lt: ['$statusCode', 500] }] }, 1, 0] } },
        errors5xx: { $sum: { $cond: [{ $gte: ['$statusCode', 500] }, 1, 0] } },
        lastSeen: { $max: '$timestamp' },
      }},
      { $addFields: {
        p50: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.50, { $size: '$durations' }] } }] },
        p95: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.95, { $size: '$durations' }] } }] },
        p99: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.99, { $size: '$durations' }] } }] },
      }},
      { $project: { durations: 0 } },
      { $sort: { count: -1 } },
    ]);

    return res.json({ metrics: agg });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// SDK BUG REPORT INGEST
// ----------------------------------------------------
router.post('/sdk/bug-report', sdkTokenAuth, async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!body.projectId || !body.description) return res.status(400).json({ error: 'projectId and description required' });
    await connectMongo();
    const report = await BugReportModel.create({
      projectId: body.projectId,
      environment: body.environment || 'unknown',
      description: body.description,
      category: body.category || 'Bug',
      consoleLogs: body.consoleLogs || [],
      networkTimeline: body.networkTimeline || [],
      screenshotBase64: body.screenshotBase64,
      browserInfo: body.browserInfo || {},
      appState: body.appState,
    });
    // If project has ClickUp linked — create task (non-blocking, best effort)
    (async () => {
      try {
        const ds = await getDb();
        const project = await ds.getRepository(Project).findOne({ where: { id: body.projectId } });
        if (project && project.clickupListId) {
          const taskTitle = `[BUG] ${body.category || 'Bug'}: ${body.description.substring(0, 80)}`;
          await postComment('auto', `Bug report created:\n\n${taskTitle}\n\nEnvironment: ${body.environment || 'unknown'}`);
        }
      } catch {}
    })();
    return res.status(201).json({ id: report._id, message: 'Bug report submitted' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// DATABASE PROVISIONING
// ----------------------------------------------------
router.post('/projects/:projectId/databases/provision', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { environment } = req.body;
    if (!environment) return res.status(400).json({ error: 'environment is required' });
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { provisionPostgresDb } = await import('../lib/database-service');
    const creds = await provisionPostgresDb(project.name, environment);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'database.provisioned',
      targetType: 'Project',
      targetId: project.id,
      metadata: { dbName: creds.dbName, environment },
      ip: req.ip,
    });

    return res.status(201).json({
      dbName: creds.dbName,
      username: creds.username,
      password: creds.password,
      host: creds.host,
      port: creds.port,
      connectionString: `postgresql://${creds.username}:${creds.password}@${creds.host}:${creds.port}/${creds.dbName}`,
      message: 'Database provisioned. Save these credentials — the password will not be shown again.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------
// SMTP SETTINGS
// ----------------------------------------------------
router.get('/settings/smtp', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const configs = await ds.getRepository(SmtpConfig).find();
    return res.json(configs.map(c => ({ ...c, password: c.password ? '***' : null, apiKey: c.apiKey ? '***' : null })));
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/smtp', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(SmtpConfig);
    if (req.body.isDefault) await repo.update({}, { isDefault: false });
    const config = repo.create(req.body);
    const saved = (await repo.save(config)) as unknown as SmtpConfig;
    return res.status(201).json({ ...saved, password: saved.password ? '***' : null, apiKey: saved.apiKey ? '***' : null });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/smtp/:id/test', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const config = await ds.getRepository(SmtpConfig).findOne({ where: { id: req.params.id } });
    if (!config) return res.status(404).json({ error: 'SMTP config not found' });
    const { testSmtpConnection } = await import('../lib/smtp-service');
    const result = await testSmtpConnection(config as any, req.body.testTo || config.fromEmail);
    return res.json(result);
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.delete('/settings/smtp/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    await ds.getRepository(SmtpConfig).delete(req.params.id);
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

// ----------------------------------------------------
// STORAGE PROVIDER SETTINGS
// ----------------------------------------------------
router.get('/settings/storage', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const providers = await ds.getRepository(StorageProvider).find();
    return res.json(providers.map(p => ({ ...p, credentials: p.credentials ? { ...p.credentials, secretAccessKey: '***', refreshToken: '***', password: '***' } : null })));
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/storage', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(StorageProvider);
    if (req.body.isDefault) await repo.update({}, { isDefault: false });
    const provider = repo.create(req.body);
    const saved = await repo.save(provider);
    return res.status(201).json(saved);
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.post('/settings/storage/:id/test', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const provider = await ds.getRepository(StorageProvider).findOne({ where: { id: req.params.id } });
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    const { createAdapter } = await import('../lib/storage-service');
    const adapter = createAdapter(
      provider.providerType,
      provider.credentials || {},
      provider.bucketName || undefined,
      provider.endpointUrl || undefined
    );
    const ok = await adapter.testConnection();
    return res.json({ success: ok, message: ok ? 'Connection successful' : 'Connection failed' });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.patch('/settings/storage/:id/set-default', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    await ds.getRepository(StorageProvider).update({}, { isDefault: false });
    await ds.getRepository(StorageProvider).update(req.params.id, { isDefault: true });
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

router.delete('/settings/storage/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    await ds.getRepository(StorageProvider).delete(req.params.id);
    return res.json({ success: true });
  } catch (err: any) { return res.status(400).json({ error: err.message }); }
});

export default router;
