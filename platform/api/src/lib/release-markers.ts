import axios from 'axios';
import { getDb } from '../config/database';
import { Deployment } from '../entities/Deployment';
import { releaseVersion } from './release-version';
import { publishAlertEvent } from './alert-events';

/** Outbox retries outages; absence of Grafana never blocks a deployment. */
export async function publishReleaseMarker(deploymentId: string): Promise<void> {
  const repo = (await getDb()).getRepository(Deployment);
  const dep = await repo.findOneByOrFail({ id: deploymentId });
  const version = releaseVersion(dep);
  await publishAlertEvent({ projectId: dep.projectId, environment: dep.environmentId || undefined,
    source: 'deploy', severity: 'info', dedupeKey: `deploy:${dep.id}`, title: `Deployed ${version}`,
    url: `/projects/${dep.projectId}?tab=releases`, labels: { release: version, deploymentId: dep.id } });
  const base = process.env.GRAFANA_URL;
  const token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  if (!base || !token || dep.metadata?.grafanaAnnotationId) return;
  const tags = ['platform-deploy', `project:${dep.projectId}`, `environment:${dep.environmentId}`, `deployment:${dep.id}`];
  const headers = { Authorization: `Bearer ${token}` };
  // Search before retry to recover a successful POST whose response was lost.
  const prior = await axios.get(`${base.replace(/\/$/, '')}/api/annotations`, { headers, timeout: 5000, params: { tags: `deployment:${dep.id}`, limit: 1 } });
  let id = prior.data?.[0]?.id;
  if (!id) {
    const result = await axios.post(`${base.replace(/\/$/, '')}/api/annotations`, {
      time: dep.deployedAt!.getTime(), tags,
      text: `Release ${version}; commit ${dep.commitSha}; author ${dep.deployedById || 'system'}; deployment ${dep.id}${dep.metadata?.rollbackFrom ? '; rollback' : ''}`,
    }, { headers, timeout: 5000 });
    id = result.data.id;
  }
  await repo.update(dep.id, { metadata: { ...(dep.metadata || {}), grafanaAnnotationId: id } });
}
