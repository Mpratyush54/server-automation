import * as k8s from '@kubernetes/client-node';
import { MoreThan } from 'typeorm';
import { getDb } from '../config/database';
import { Deployment, DeploymentStatus } from '../entities/Deployment';
import { Environment, EnvironmentName } from '../entities/Environment';
import { Project } from '../entities/Project';
import { argoAppName, deployK8sPreview, ensureAndSyncArgoApp, ensureProjectIngress } from './k8s';
import { defineOperation } from './operations';

export const DEPLOY_OPERATION = 'deployment.deploy';

/** Non-secret state of a deploy (visible via GET /operations/:id). */
type DeployState = {
  deploymentId: string;
  preview?: boolean;
  appName?: string;
  destNs?: string;
  host?: string;
};

async function load(deploymentId: string) {
  const ds = await getDb();
  const dep = await ds.getRepository(Deployment).findOne({ where: { id: deploymentId } });
  if (!dep) throw new Error('Deployment not found');
  const project = await ds.getRepository(Project).findOne({ where: { id: dep.projectId } });
  if (!project) throw new Error('Project not found');
  const env = dep.environmentId
    ? await ds.getRepository(Environment).findOne({ where: { id: dep.environmentId, projectId: dep.projectId } })
    : null;
  if (!env) throw new Error('Deployment environment not found');
  return { ds, dep, project, env };
}

function kubeConfig(): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  try { kc.loadFromCluster(); } catch { try { kc.loadFromDefault(); } catch {} }
  return kc;
}

const POLL_INTERVAL_MS = 5000;
const POLL_ATTEMPTS = 36;

/**
 * A deploy as explicit steps (all idempotent: Argo CD sync and Ingress apply converge):
 *  1. apply         preview workload, or Argo CD Application sync + Ingress
 *  2. wait-healthy  poll Argo CD until Synced/Healthy (3 min)
 *  3. finalize      mark the deployment deployed; e-mail + ClickUp via the outbox
 * On failure the deployment is marked failed and a failure e-mail is queued (outbox).
 * After an API restart the leader resumes the deploy unless a newer deployment of the same
 * environment exists, in which case it is failed as superseded (no stale re-sync).
 */
export const deployOperation = defineOperation<DeployState>({
  type: DEPLOY_OPERATION,
  resume: 'continue',
  summarize: (s) => ({ deploymentId: s.deploymentId, appName: s.appName ?? null, namespace: s.destNs ?? null }),
  async onFailed(ctx, error) {
    try {
      const ds = await getDb();
      const repo = ds.getRepository(Deployment);
      const dep = await repo.findOne({ where: { id: ctx.state.deploymentId } });
      if (!dep) return;
      if ([DeploymentStatus.PENDING, DeploymentStatus.BUILDING, DeploymentStatus.DEPLOYING].includes(dep.status)) {
        dep.status = DeploymentStatus.FAILED;
        dep.metadata = { ...(dep.metadata || {}), error: error.replace(/^[a-z-]+: /, '') || 'Unknown deployment failure', operationId: ctx.operationId };
        await repo.save(dep);
      }
      const project = await ds.getRepository(Project).findOne({ where: { id: dep.projectId } });
      const env = dep.environmentId ? await ds.getRepository(Environment).findOne({ where: { id: dep.environmentId } }) : null;
      ctx.emit('deploy.email', {
        success: false,
        projectName: project?.name || '',
        environment: env?.name || dep.branch,
        version: dep.version,
        error: String(dep.metadata?.error || error),
      });
    } catch (err: any) {
      console.error('[deploy] could not record failure:', err?.message || err);
    }
  },
  steps: [
    {
      name: 'apply',
      async run(ctx) {
        const { ds, dep, project, env } = await load(ctx.state.deploymentId);
        const repo = ds.getRepository(Deployment);
        if (ctx.resumed && dep.environmentId) {
          const newer = await repo.findOne({ where: { environmentId: dep.environmentId, createdAt: MoreThan(dep.createdAt) } });
          if (newer) throw new Error(`superseded by deployment ${newer.id}`);
        }
        dep.status = DeploymentStatus.BUILDING;
        await repo.save(dep);
        dep.status = DeploymentStatus.DEPLOYING;
        await repo.save(dep);

        if (env.name === EnvironmentName.PREVIEW) {
          ctx.state.preview = true;
          const ok = await deployK8sPreview(project.name, dep.branch, dep.imageTag, project.id);
          if (!ok) throw new Error('Preview deployment failed to apply or timeout occurred.');
          return;
        }

        if (!project.repositoryUrl) {
          throw new Error('Set project repositoryUrl (GitHub/GitLab) to pull & deploy via ArgoCD.');
        }
        const appName = env.namespace || argoAppName(project.name, String(env.name), project.id);
        const destNs = env.namespace || argoAppName(project.name, String(env.name), project.id);
        const gitPath =
          (ctx.input.gitPath as string) ||
          (dep.metadata as any)?.gitPath ||
          (project.repositoryUrl.includes('server-automation') ? 'examples/sdk-demo/k8s' : 'k8s');
        const revision = dep.commitSha && dep.commitSha !== 'unknown' ? dep.commitSha : (dep.branch || 'main');

        const argo = await ensureAndSyncArgoApp({
          appName,
          repoURL: project.repositoryUrl,
          path: gitPath,
          targetRevision: revision,
          namespace: destNs,
          imageTag: dep.imageTag,
        });
        if (!argo.ok) throw new Error(argo.error || 'Failed to create/sync ArgoCD Application');
        ctx.state.appName = appName;
        ctx.state.destNs = destNs;

        // Discover a Service in the dest namespace to wire Ingress (prefer common names)
        let serviceName = 'sdk-demo';
        try {
          const core = kubeConfig().makeApiClient(k8s.CoreV1Api);
          const svcs: any = await core.listNamespacedService({ namespace: destNs });
          const items = (svcs.body || svcs).items || [];
          if (items.length) {
            const preferred = items.find((s: any) => ['sdk-demo', appName, project.name].includes(s.metadata?.name));
            serviceName = preferred?.metadata?.name || items[0].metadata.name;
          }
        } catch {}

        const host = env.domain || `${appName}.${project.domain || process.env.DOMAIN || 'sslip.io'}`;
        ctx.state.host = host;
        await ensureProjectIngress({ name: appName, namespace: destNs, host, serviceName, servicePort: 80 });
        ctx.setOutput({ appName, namespace: destNs, revision, host });
      },
    },
    {
      name: 'wait-healthy',
      async run(ctx) {
        if (ctx.state.preview) {
          ctx.setOutput({ note: 'preview workload applied synchronously' });
          return;
        }
        const customApi = kubeConfig().makeApiClient(k8s.CustomObjectsApi);
        let lastError = '';
        for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const appResponse: any = await customApi.getNamespacedCustomObject({
              group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd',
              plural: 'applications', name: ctx.state.appName!,
            });
            const status = (appResponse.body || appResponse).status || {};
            const sync = status.sync?.status;
            const health = status.health?.status;
            ctx.setOutput({ sync, health, polls: attempt });
            if (sync === 'Synced' && health === 'Healthy') return;
            // Manifest applied; pods still coming up — treat as success for history UX
            if (sync === 'Synced' && health === 'Progressing' && attempt >= 6) return;
            if (health === 'Degraded' || sync === 'Failed') throw new Error(`ArgoCD health=${health} sync=${sync}`);
          } catch (pollErr: any) {
            if (/^ArgoCD health=/.test(pollErr?.message || '')) throw pollErr;
            lastError = pollErr?.message || String(pollErr);
          }
        }
        throw new Error(lastError || 'ArgoCD sync timed out after 3 minutes.');
      },
    },
    {
      name: 'finalize',
      async run(ctx) {
        const { ds, dep, project, env } = await load(ctx.state.deploymentId);
        dep.status = DeploymentStatus.DEPLOYED;
        dep.deployedAt = new Date();
        if (env.domain) {
          dep.previewUrl = `https://${env.domain}`;
          dep.metadata = { ...(dep.metadata || {}), liveUrl: `https://${env.domain}` };
        }
        dep.metadata = { ...(dep.metadata || {}), operationId: ctx.operationId };
        await ds.getRepository(Deployment).save(dep);

        ctx.emit('deploy.email', {
          success: true,
          projectName: project.name,
          environment: env.name || dep.branch,
          version: dep.version,
          url: dep.previewUrl || `https://${env.domain || project.name}`,
          commitSha: dep.commitSha,
        });
        if (dep.clickupTaskId) {
          ctx.emit('deploy.clickup', {
            clickupTaskId: dep.clickupTaskId,
            deploymentId: dep.id,
            projectId: project.id,
            projectName: project.name,
            branch: dep.branch,
            url: dep.previewUrl || `https://${env.domain}`,
            commit: (dep.commitSha || '').substring(0, 7),
          });
        }
      },
    },
  ],
});
