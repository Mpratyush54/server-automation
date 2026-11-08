import * as k8s from '@kubernetes/client-node';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { Environment, EnvironmentName } from '../entities/Environment';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { BackgroundJob } from '../entities/BackgroundJob';
import { ClickupTaskLink } from '../entities/ClickupTaskLink';
import { SmtpConfig } from '../entities/SmtpConfig';
import { User, UserRole } from '../entities/User';
import { postComment, formatPreviewComment } from './clickup';
import { deployK8sPreview, ensureAndSyncArgoApp, argoAppName, ensureProjectIngress } from './k8s';
import {
  JobHandler, JobStore, enqueueAndRun, recoverStaleJobs, typeormJobStore,
} from './background-jobs';

/**
 * Deployment rollout as a durable background job (`background_jobs`, type
 * `deploy`). Every step is idempotent (Argo app ensure+sync, preview apply,
 * ingress ensure), so a rollout interrupted by an API restart is re-run from
 * the start by the leader, or the deployment is marked failed — it never
 * stays pending/building/deploying.
 */

export const DEPLOY_JOB_TYPE = 'deploy';

const NON_TERMINAL: DeploymentStatus[] = [DeploymentStatus.PENDING, DeploymentStatus.BUILDING, DeploymentStatus.DEPLOYING];

/** Deployments older than this in a non-terminal state with no job row are orphans (pre-upgrade rollouts). */
export const ORPHAN_AGE_MS = 10 * 60 * 1000;

export function isTerminalDeploymentStatus(status: DeploymentStatus | string): boolean {
  return !NON_TERMINAL.includes(status as DeploymentStatus);
}

type StepFn = (step: string) => Promise<void>;

/** Run (or re-run) the rollout for one deployment and record the outcome on it. */
export async function executeDeployment(deploymentId: string, setStep: StepFn = async () => {}): Promise<void> {
  const checkDs = await getDb();
  const depRepo = checkDs.getRepository(Deployment);
  const dep = await depRepo.findOne({ where: { id: deploymentId } });
  if (!dep) return;
  const project = await checkDs.getRepository(Project).findOne({ where: { id: dep.projectId } });
  const env = dep.environmentId
    ? await checkDs.getRepository(Environment).findOne({ where: { id: dep.environmentId } })
    : null;
  if (!project || !env) {
    await markFailed(deploymentId, !project ? 'Project no longer exists' : 'Environment no longer exists');
    return;
  }

  dep.status = DeploymentStatus.BUILDING;
  await depRepo.save(dep);
  await setStep('building');

  let success = false;
  let deployError = '';

  if (env.name === EnvironmentName.PREVIEW) {
    dep.status = DeploymentStatus.DEPLOYING;
    await depRepo.save(dep);
    await setStep('apply-preview');

    success = await deployK8sPreview(project.name, dep.branch, dep.imageTag, project.id);
    if (!success) {
      deployError = 'Preview deployment failed to apply or timeout occurred.';
    }
  } else {
    dep.status = DeploymentStatus.DEPLOYING;
    await depRepo.save(dep);
    await setStep('argo-sync');

    if (!project.repositoryUrl) {
      deployError = 'Set project repositoryUrl (GitHub/GitLab) to pull & deploy via ArgoCD.';
      success = false;
    } else {
      const appName = env.namespace || argoAppName(project.name, String(env.name), project.id);
      const destNs = env.namespace || argoAppName(project.name, String(env.name), project.id);
      const gitPath =
        ((dep.metadata as any)?.gitPath as string) ||
        (project.repositoryUrl.includes('server-automation') ? 'examples/sdk-demo/k8s' : 'k8s');
      const revision = dep.commitSha && dep.commitSha !== 'unknown'
        ? dep.commitSha
        : (dep.branch || 'main');

      const argo = await ensureAndSyncArgoApp({
        appName,
        repoURL: project.repositoryUrl,
        path: gitPath,
        targetRevision: revision,
        namespace: destNs,
        imageTag: dep.imageTag,
      });

      if (argo.ok) {
        // Discover a Service in the dest namespace to wire Ingress (prefer common names)
        let serviceName = 'sdk-demo';
        try {
          const kcDiscover = new k8s.KubeConfig();
          try { kcDiscover.loadFromCluster(); } catch { try { kcDiscover.loadFromDefault(); } catch {} }
          const coreDiscover = kcDiscover.makeApiClient(k8s.CoreV1Api);
          const svcs: any = await coreDiscover.listNamespacedService({ namespace: destNs });
          const items = (svcs.body || svcs).items || [];
          if (items.length) {
            const preferred = items.find((s: any) =>
              ['sdk-demo', appName, project.name].includes(s.metadata?.name)
            );
            serviceName = preferred?.metadata?.name || items[0].metadata.name;
          }
        } catch {}

        const host =
          env.domain ||
          `${appName}.${project.domain || process.env.DOMAIN || 'sslip.io'}`;
        await ensureProjectIngress({
          name: appName,
          namespace: destNs,
          host,
          serviceName,
          servicePort: 80,
        });
        await setStep('wait-healthy');

        let attempts = 0;
        const maxAttempts = 36;
        const kcLocal = new k8s.KubeConfig();
        try { kcLocal.loadFromCluster(); } catch { try { kcLocal.loadFromDefault(); } catch {} }
        const customApi = kcLocal.makeApiClient(k8s.CustomObjectsApi);

        while (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 5000));
          attempts++;
          try {
            const appResponse: any = await customApi.getNamespacedCustomObject({
              group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
              plural: 'applications', name: appName,
            });
            const status = (appResponse.body || appResponse).status || {};
            const sync = status.sync?.status;
            const health = status.health?.status;
            if (sync === 'Synced' && health === 'Healthy') {
              success = true;
              break;
            }
            if (sync === 'Synced' && health === 'Progressing' && attempts >= 6) {
              // Manifest applied; pods still coming up — treat as success for history UX
              success = true;
              break;
            }
            if (health === 'Degraded' || sync === 'Failed') {
              deployError = `ArgoCD health=${health} sync=${sync}`;
              break;
            }
          } catch (pollErr: any) {
            deployError = pollErr.message;
          }
        }
        if (!success && !deployError) {
          deployError = 'ArgoCD sync timed out after 3 minutes.';
        }
      } else {
        deployError = argo.error || 'Failed to create/sync ArgoCD Application';
      }
    }
  }

  await setStep('finalize');
  const finalDep = await depRepo.findOne({ where: { id: deploymentId } });
  if (!finalDep) return;
  if (success) {
    finalDep.status = DeploymentStatus.DEPLOYED;
    finalDep.deployedAt = new Date();
    if (env.domain) {
      finalDep.previewUrl = `https://${env.domain}`;
      finalDep.metadata = {
        ...(finalDep.metadata || {}),
        liveUrl: `https://${env.domain}`,
      };
    }
  } else {
    finalDep.status = DeploymentStatus.FAILED;
    finalDep.metadata = {
      ...(finalDep.metadata || {}),
      error: deployError || 'Unknown deployment failure',
    };
  }
  await depRepo.save(finalDep);

  // Notifications are best-effort and run after the terminal state is saved:
  // a restart from here on is not re-run (the job sees a terminal deployment).
  await setStep('notify');
  void notifyDeploymentResult(project, env, finalDep, success, deployError);

  if (success && finalDep.clickupTaskId) {
    try {
      const comment = await formatPreviewComment({
        project: project.name,
        branch: finalDep.branch,
        url: finalDep.previewUrl || `https://${env.domain}`,
        commit: finalDep.commitSha.substring(0, 7),
      });
      await postComment(finalDep.clickupTaskId, comment);

      const linkRepo = checkDs.getRepository(ClickupTaskLink);
      const link = linkRepo.create({
        clickupTaskId: finalDep.clickupTaskId,
        deploymentId: finalDep.id,
        projectId: project.id,
        branch: finalDep.branch,
      });
      await linkRepo.save(link);
    } catch (err: any) {
      console.warn('[clickup] Deployment link failed (non-blocking):', err.message);
    }
  }
}

async function notifyDeploymentResult(project: Project, env: Environment, finalDep: Deployment, success: boolean, deployError: string): Promise<void> {
  try {
    const checkDs = await getDb();
    const smtpCfg = await checkDs.getRepository(SmtpConfig).findOne({ where: { isDefault: true } });
    if (!smtpCfg) return;
    const { sendMail, buildDeploymentSuccessEmail, buildDeploymentFailedEmail } = await import('./smtp-service');
    const devopsUsers = await checkDs.getRepository(User).find({ where: { role: UserRole.DEVOPS } });
    const to = devopsUsers.map(u => u.email).filter(Boolean);
    if (to.length === 0) return;
    if (success) {
      const html = buildDeploymentSuccessEmail({
        projectName: project.name,
        environment: env?.name || finalDep.branch,
        version: finalDep.version,
        url: finalDep.previewUrl || `https://${env?.domain || project.name}`,
        commitSha: finalDep.commitSha,
        deployedBy: 'Platform',
      });
      await sendMail(smtpCfg as any, to, `[${project.name}] Deployment Successful — ${env?.name || finalDep.branch}`, html);
    } else {
      const html = buildDeploymentFailedEmail({
        projectName: project.name,
        environment: env?.name || finalDep.branch,
        version: finalDep.version,
        error: deployError || 'Unknown failure',
        deployedBy: 'Platform',
      });
      await sendMail(smtpCfg as any, to, `[${project.name}] Deployment FAILED — ${env?.name || finalDep.branch}`, html);
    }
  } catch (smtpErr: any) {
    console.warn('[smtp] Notification failed (non-blocking):', smtpErr.message);
  }
}

/** Set a deployment to FAILED unless it already reached a terminal state. */
export async function markFailed(deploymentId: string, error: string): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(Deployment);
  const dep = await repo.findOne({ where: { id: deploymentId } });
  if (dep && !isTerminalDeploymentStatus(dep.status)) {
    dep.status = DeploymentStatus.FAILED;
    dep.metadata = { ...(dep.metadata || {}), error };
    await repo.save(dep);
  }
}

export const deployJobHandler: JobHandler = {
  async run(job, ctx) {
    await executeDeployment(job.targetId, ctx.setStep);
  },
  async isComplete(job) {
    const ds = await getDb();
    const dep = await ds.getRepository(Deployment).findOne({ where: { id: job.targetId } });
    return !dep || isTerminalDeploymentStatus(dep.status);
  },
  async onGiveUp(job, reason) {
    await markFailed(job.targetId, reason);
  },
};

export const jobHandlers: Record<string, JobHandler> = { [DEPLOY_JOB_TYPE]: deployJobHandler };

let store: JobStore | null = null;
export function getJobStore(): JobStore {
  if (!store) store = typeormJobStore(async () => (await getDb()).getRepository(BackgroundJob));
  return store;
}

/** Test hook. */
export function setJobStoreForTests(s: JobStore | null): void {
  store = s;
}

/** Persist the rollout for `deploymentId` and start it on this replica. */
export async function enqueueDeployment(deploymentId: string): Promise<void> {
  await enqueueAndRun(getJobStore(), jobHandlers, { type: DEPLOY_JOB_TYPE, targetId: deploymentId, maxAttempts: 2 });
}

/**
 * Deployments left non-terminal with no job row (POST /deploy rollouts started
 * by an API version without durable jobs, then interrupted) are marked failed.
 */
export async function failOrphanedDeployments(): Promise<number> {
  const ds = await getDb();
  const repo = ds.getRepository(Deployment);
  const orphans = await repo.createQueryBuilder('d')
    .where('d.status IN (:...statuses)', { statuses: NON_TERMINAL })
    .andWhere('d.createdAt < :cutoff', { cutoff: new Date(Date.now() - ORPHAN_AGE_MS) })
    // Only rollouts started by POST /deploy (they always carry pullFromGit);
    // webhook "staging" rows stay pending while an external CI pipeline runs.
    .andWhere(`(d.metadata ->> 'pullFromGit') IS NOT NULL`)
    .andWhere('NOT EXISTS (SELECT 1 FROM background_jobs j WHERE j.target_id = d.id)')
    .getMany();
  for (const dep of orphans) {
    dep.status = DeploymentStatus.FAILED;
    dep.metadata = { ...(dep.metadata || {}), error: 'Deployment interrupted by an API restart' };
    await repo.save(dep);
    console.warn(`[deploy-recovery] marked orphaned deployment ${dep.id} failed`);
  }
  return orphans.length;
}

/** Leader job: resume or fail interrupted rollouts. */
export async function runDeployRecovery(): Promise<void> {
  const { resumed, failed } = await recoverStaleJobs(getJobStore(), jobHandlers);
  const orphans = await failOrphanedDeployments();
  if (resumed.length || failed.length || orphans) {
    console.log(`[deploy-recovery] resumed=${resumed.length} failed=${failed.length} orphaned=${orphans}`);
  }
}
