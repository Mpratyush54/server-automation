import { Router } from 'express';
import { getDb } from '../config/database';
import { Build } from '../entities/Build';
import { Environment } from '../entities/Environment';
import { Project } from '../entities/Project';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { AuthenticatedRequest, expressAuthenticate, logAudit } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { idempotency } from '../middleware/idempotency';
import { requireProjectAccess } from '../lib/project-access';
import { BuildLimitError, assertManualBuildAllowed, buildsEnabled, enqueueBuild } from '../lib/build-op';
import { fetchBranchCommits } from '../lib/git-remote';
import { validateBuildRef } from '../lib/build-spec';
import { parseGitRemote } from '../lib/git-remote';
import { RepositoryNotApprovedError, repositoryApproved, repositoryKey } from '../lib/repository-binding';

/** Repository approvals are a platform-administrator decision, made by a person (not an agent token). */
function isPlatformAdmin(req: AuthenticatedRequest): boolean {
  return req.user?.role === UserRole.ADMIN && !req.agentToken;
}

function repositoryState(project: Project | null, req: AuthenticatedRequest) {
  return {
    url: project?.repositoryUrl || null,
    approved: repositoryApproved(project),
    approvedAt: repositoryApproved(project) ? project!.repositoryApprovedAt : null,
    canApprove: isPlatformAdmin(req),
  };
}

const router = Router();
router.use('/projects/:projectId/builds', expressAuthenticate);

router.get('/projects/:projectId/builds', async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.VIEWER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const ds = await getDb();
    const builds = await ds.getRepository(Build).find({ where: { projectId: req.params.projectId }, order: { createdAt: 'DESC' }, take: 100,
      select: ['id', 'environmentId', 'commitSha', 'branch', 'status', 'startedAt', 'finishedAt', 'triggeredBy', 'imageDigest', 'error', 'deploymentId', 'createdAt'] });
    const environments = await ds.getRepository(Environment).find({ where: { projectId: req.params.projectId, isActive: true },
      select: ['id', 'name', 'buildOnPush', 'buildBranch'] });
    const project = await ds.getRepository(Project).findOneBy({ id: req.params.projectId, isActive: true });
    return res.json({ enabled: buildsEnabled(), builds, environments, repository: repositoryState(project, req as AuthenticatedRequest) });
  } catch { return res.status(500).json({ error: 'Could not load builds' }); }
});

router.get('/projects/:projectId/builds/:buildId/logs', async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVELOPER);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const build = await (await getDb()).getRepository(Build).findOneBy({ id: req.params.buildId, projectId: req.params.projectId });
    if (!build) return res.status(404).json({ error: 'Build not found' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ logs: build.logs, status: build.status });
  } catch { return res.status(500).json({ error: 'Could not load build logs' }); }
});

router.patch('/projects/:projectId/builds/settings', async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    if (!buildsEnabled()) return res.status(409).json({ error: 'Source builds are disabled by the installer' });
    const { environmentId, buildOnPush, branch } = req.body;
    if (typeof buildOnPush !== 'boolean') return res.status(400).json({ error: 'buildOnPush must be a boolean' });
    if (typeof environmentId !== 'string') return res.status(400).json({ error: 'environmentId is required' });
    validateBuildRef(branch, 'a'.repeat(40));
    const ds = await getDb();
    const repo = ds.getRepository(Environment);
    const env = await repo.findOneBy({ id: environmentId, projectId: req.params.projectId, isActive: true });
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    if (buildOnPush && !repositoryApproved(await ds.getRepository(Project).findOneBy({ id: req.params.projectId, isActive: true }))) {
      return res.status(409).json({ error: new RepositoryNotApprovedError().message });
    }
    env.buildOnPush = buildOnPush; env.buildBranch = branch;
    await repo.save(env);
    return res.json({ id: env.id, buildOnPush, branch });
  } catch { return res.status(400).json({ error: 'Could not save build settings; check the branch' }); }
});

router.post('/projects/:projectId/builds', idempotency('POST /projects/:projectId/builds'), async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    if (!buildsEnabled()) return res.status(409).json({ error: 'Source builds are disabled by the installer' });
    if (typeof req.body.environmentId !== 'string') return res.status(400).json({ error: 'environmentId is required' });
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOneBy({ id: req.params.projectId, isActive: true });
    const env = await ds.getRepository(Environment).findOneBy({ id: req.body.environmentId, projectId: req.params.projectId, isActive: true });
    if (!project?.repositoryUrl || !env) return res.status(404).json({ error: 'Linked project environment not found' });
    validateBuildRef(req.body.branch, 'a'.repeat(40));
    await assertManualBuildAllowed(project.id);
    const commits = await fetchBranchCommits(project.repositoryUrl, req.body.branch, 1);
    if (!commits[0]) return res.status(400).json({ error: 'Branch has no commit' });
    const build = await enqueueBuild(project, env, req.body.branch, commits[0].sha, (req as AuthenticatedRequest).user!.id);
    return res.status(202).json({ id: build.id, operationId: build.id, status: build.status });
  } catch (error) {
    if (error instanceof BuildLimitError) return res.status(429).json({ error: error.message });
    if (error instanceof RepositoryNotApprovedError) return res.status(409).json({ error: error.message });
    return res.status(400).json({ error: 'Could not queue source build' });
  }
});

/** A platform administrator approves the project's current repository for source builds. */
router.post('/projects/:projectId/builds/repository-approval', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!isPlatformAdmin(authReq)) return res.status(403).json({ error: 'Only a platform administrator can approve a repository for builds' });
    const ds = await getDb();
    const repo = ds.getRepository(Project);
    const project = await repo.findOneBy({ id: req.params.projectId, isActive: true });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const key = repositoryKey(project.repositoryUrl);
    const remote = parseGitRemote(project.repositoryUrl);
    if (!key || !remote || remote.provider === 'unknown') return res.status(400).json({ error: 'Link a GitHub or GitLab repository before approving it' });
    if (project.repositoryKey !== key) return res.status(409).json({ error: 'Save the project repository again before approving it' });
    // Approve only the repository the administrator was shown, when the client says which one.
    if (typeof req.body?.repositoryUrl === 'string' && repositoryKey(req.body.repositoryUrl) !== key) {
      return res.status(409).json({ error: 'The project repository changed; review it and approve again' });
    }
    const approvedAt = new Date();
    await repo.update({ id: project.id, repositoryKey: key }, { repositoryApprovedBy: authReq.user!.id, repositoryApprovedAt: approvedAt, repositoryApprovedKey: key });
    await logAudit({ userId: authReq.user!.id, action: 'build.repository_approved', targetType: 'Project', targetId: project.id, metadata: { repository: key }, ip: req.ip });
    return res.json({ url: project.repositoryUrl, approved: true, approvedAt, canApprove: true });
  } catch { return res.status(400).json({ error: 'Could not approve the repository' }); }
});

router.delete('/projects/:projectId/builds/repository-approval', async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!isPlatformAdmin(authReq)) return res.status(403).json({ error: 'Only a platform administrator can withdraw a repository approval' });
    const repo = (await getDb()).getRepository(Project);
    const project = await repo.findOneBy({ id: req.params.projectId, isActive: true });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await repo.update({ id: project.id }, { repositoryApprovedBy: null, repositoryApprovedAt: null, repositoryApprovedKey: null });
    await logAudit({ userId: authReq.user!.id, action: 'build.repository_approval_withdrawn', targetType: 'Project', targetId: project.id, ip: req.ip });
    return res.json({ url: project.repositoryUrl, approved: false, approvedAt: null, canApprove: true });
  } catch { return res.status(400).json({ error: 'Could not withdraw the repository approval' }); }
});

export default router;
