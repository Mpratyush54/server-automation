import { parseGitRemote } from '../lib/git-remote';
import { requireProjectAccess } from '../lib/project-access';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest, logAudit } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { findInstallationForRepo, loadGithubApp } from '../lib/github-app';
import { gitlabWebhookCredentials } from '../lib/gitlab-app';
import { githubInstallUrl } from '../lib/git-app-store';

const router = Router();

router.post('/cicd/register-webhook/:projectId', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const access = await requireProjectAccess(req as AuthenticatedRequest, projectId, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });

    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.repositoryUrl) {
      return res.status(400).json({ error: 'No repository URL configured for this project' });
    }

    const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/gitlab`;
    const remote = parseGitRemote(project.repositoryUrl);
    if (!remote) return res.status(400).json({ error: 'Unsupported repository origin' });

    if (remote.provider === 'gitlab') {
      const GITLAB_API = remote.apiBase;
      // #35: token + hook secret from the automated GitLab connect; env values remain the fallback.
      const { apiToken: TOKEN, secret: token } = await gitlabWebhookCredentials();
      if (!token) return res.status(500).json({ error: 'GITLAB_WEBHOOK_SECRET must be configured' });
      if (!TOKEN) return res.status(500).json({ error: 'GITLAB_TOKEN not configured (connect GitLab with "keep token" or set a linking token)' });

      const projectIdPath = `${remote.owner}/${remote.repo}`;
      const response = await fetch(`${GITLAB_API}/projects/${encodeURIComponent(projectIdPath)}/hooks`, {
        method: 'POST',
        redirect: 'error',
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
      await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'cicd.webhook.registered', targetType: 'Project', targetId: project.id, metadata: { provider: 'gitlab', mode: 'token' }, ip: req.ip });
      return res.json({ success: true, message: 'Webhook registered on GitLab', webhookUrl });
    }

    if (remote.provider === 'github') {
      // #35: with the GitHub App connected, push/pull_request events for every repository the
      // App is installed on arrive on the App webhook (signed with the App's secret), so no
      // personal token and no per-repository hook are needed.
      const app = await loadGithubApp();
      if (app) {
        const inst = await findInstallationForRepo(remote.owner, remote.repo);
        if (inst) {
          await logAudit({
            userId: (req as AuthenticatedRequest).user?.id,
            action: 'cicd.webhook.linked',
            targetType: 'Project',
            targetId: project.id,
            metadata: { provider: 'github', mode: 'github-app', installationId: inst.installationId },
            ip: req.ip,
          });
          return res.json({
            success: true,
            mode: 'github-app',
            message: 'Repository is covered by the GitHub App installation; events are delivered to the App webhook',
            webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/github`,
            installationId: inst.installationId,
          });
        }
        if (!process.env.GITHUB_TOKEN) {
          return res.status(409).json({
            error: `The GitHub App is not installed on ${remote.owner}/${remote.repo}. Install it on the repository, then retry.`,
            installUrl: app.slug ? githubInstallUrl(app.slug) : null,
          });
        }
      }
      const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
      const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
      if (!GITHUB_TOKEN || !GITHUB_WEBHOOK_SECRET) {
        return res.status(500).json({ error: 'GITHUB_TOKEN and GITHUB_WEBHOOK_SECRET must be configured' });
      }

      const ownerRepo = `${remote.owner}/${remote.repo}`;
      const response = await fetch(`https://api.github.com/repos/${ownerRepo}/hooks`, {
        method: 'POST',
        redirect: 'error',
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
      await logAudit({ userId: (req as AuthenticatedRequest).user?.id, action: 'cicd.webhook.registered', targetType: 'Project', targetId: project.id, metadata: { provider: 'github', mode: 'token' }, ip: req.ip });
      return res.json({ success: true, message: 'Webhook registered on GitHub', webhookUrl: `${req.protocol}://${req.get('host')}/api/webhooks/github` });
    }

    return res.status(400).json({ error: 'Unsupported repository host. Only GitHub and GitLab are supported.' });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

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

export default router;
