import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import { triggerPipeline } from '../lib/gitlab';
import { postComment, formatPreviewComment, extractTaskId } from '../lib/clickup';
import { generatePreviewUrl } from '../lib/preview';
import { deployK8sPreview, terminateK8sPreview } from '../lib/k8s';
import * as crypto from 'crypto';

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

function verifyGitHubSignature(payload: string, signature: string | undefined): boolean {
  if (!GITHUB_WEBHOOK_SECRET || !signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

const GITLAB_WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET || '';

function verifyGitLabToken(token: string | undefined): boolean {
  if (!GITLAB_WEBHOOK_SECRET) return true;
  return token === GITLAB_WEBHOOK_SECRET;
}

const router = Router();

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
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
        const previewUrl = generatePreviewUrl(branch, projectSlug);
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
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
        const previewUrl = generatePreviewUrl(branch, projectSlug);
        const deployment = ds.getRepository(Deployment).create({
          projectId: project.id,
          branch,
          commitSha,
          version: `preview-${Date.now()}`,
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

      const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
      const previewUrl = generatePreviewUrl(branch, projectSlug);
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
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
        const previewUrl = generatePreviewUrl(branch, projectSlug);
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
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
        const previewUrl = generatePreviewUrl(branch, projectSlug);
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

export default router;
