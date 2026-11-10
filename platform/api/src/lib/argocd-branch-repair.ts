import { gitUrlsMatch } from './git-url';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { argoAppName } from './k8s';
import { argoClient, argoResource } from './argocd';
import { repositoryHasBranch, resolveDefaultBranch } from './git-default-branch';
import { getLeadership } from './leader';
import { logAudit } from '../middleware/auth';

/** Idempotent, leader-run startup repair; hourly retry covers provider/cluster outages. */
export async function repairArgoDefaultBranches(): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(Project);
  const projects = await repo.find({ where: { isActive: true }, relations: ['environments'] });
  const client = argoClient();
  for (const project of projects) {
    if (!getLeadership().isLeader()) return;
    if (!project.repositoryUrl || project.gitRevision) continue;
    // Only examine server-assigned project applications, never arbitrary cluster applications.
    let discovery: string | undefined;
    for (const env of project.environments || []) {
      const name = env.namespace || argoAppName(project.name, String(env.name), project.id);
      try {
        const response: any = await client.getNamespacedCustomObject({ ...argoResource, name });
        const app = response.body || response;
        if (app.spec?.sources || app.spec?.source?.targetRevision !== 'main' || !gitUrlsMatch(app.spec?.source?.repoURL, project.repositoryUrl)) continue;
        if (discovery === undefined) {
          discovery = 'HEAD';
          if (await repositoryHasBranch(project.repositoryUrl, 'main') === false) {
            discovery = await resolveDefaultBranch(project.repositoryUrl);
          }
        }
        if (discovery === 'HEAD' || discovery === 'main') continue;
        if (!getLeadership().isLeader()) return;
        await client.patchNamespacedCustomObject({ ...argoResource, name, body: [
          { op: 'test', path: '/metadata/resourceVersion', value: app.metadata.resourceVersion },
          { op: 'test', path: '/spec/source/targetRevision', value: 'main' },
          { op: 'replace', path: '/spec/source/targetRevision', value: discovery },
        ] });
        await repo.update({ id: project.id, repositoryUrl: project.repositoryUrl }, { defaultBranch: discovery });
        await logAudit({ action: 'argocd.branch_repaired', targetType: 'Project', targetId: project.id, metadata: { appName: name, branch: discovery } });
      } catch (err: any) {
        if ((err.code || err.statusCode) !== 404) console.warn(`[argo-branch-repair] ${name}: repair deferred`);
      }
    }
  }
}
