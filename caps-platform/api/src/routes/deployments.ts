import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { Environment, EnvironmentName } from '../entities/Environment';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { ClickupTaskLink } from '../entities/ClickupTaskLink';
import { SmtpConfig } from '../entities/SmtpConfig';
import { User, UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';
import { triggerPipeline } from '../lib/gitlab';
import { postComment, formatPreviewComment, extractTaskId } from '../lib/clickup';
import { generatePreviewUrl } from '../lib/preview';
import { deployK8sPreview, updateArgoCDApp } from '../lib/k8s';
import * as k8s from '@kubernetes/client-node';

const router = Router();

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
        const projectSlug = project.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-').replace(/^-|-$/g, '');
        const previewUrl = generatePreviewUrl(body.branch || 'preview', projectSlug, project.domain || process.env.DOMAIN || 'sslip.io');
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

          // --- SMTP Deployment Notification ---
          (async () => {
            try {
              const smtpRepo = checkDs.getRepository(SmtpConfig);
              const smtpCfg = await smtpRepo.findOne({ where: { isDefault: true } });
              if (smtpCfg) {
                const { sendMail, buildDeploymentSuccessEmail, buildDeploymentFailedEmail } = await import('../lib/smtp-service');
                const usersRepo = checkDs.getRepository(User);
                const devopsUsers = await usersRepo.find({ where: { role: UserRole.DEVOPS } });
                const to = devopsUsers.map(u => u.email).filter(Boolean);
                if (to.length > 0) {
                  if (success) {
                    const html = buildDeploymentSuccessEmail({
                      projectName: project.name,
                      environment: env?.name || finalDep.branch,
                      version: finalDep.version,
                      url: finalDep.previewUrl || `https://${env?.domain || project.name}`,
                      commitSha: finalDep.commitSha,
                      deployedBy: 'CAPS Platform',
                    });
                    await sendMail(smtpCfg as any, to, `[${project.name}] Deployment Successful — ${env?.name || finalDep.branch}`, html);
                  } else {
                    const html = buildDeploymentFailedEmail({
                      projectName: project.name,
                      environment: env?.name || finalDep.branch,
                      version: finalDep.version,
                      error: deployError || 'Unknown failure',
                      deployedBy: 'CAPS Platform',
                    });
                    await sendMail(smtpCfg as any, to, `[${project.name}] Deployment FAILED — ${env?.name || finalDep.branch}`, html);
                  }
                }
              }
            } catch (smtpErr: any) {
              console.warn('[smtp] Notification failed (non-blocking):', smtpErr.message);
            }
          })();

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

export default router;
