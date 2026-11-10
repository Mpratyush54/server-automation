import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from './kube-config';

export const argoResource = { group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications' };
export function argoClient(): k8s.CustomObjectsApi {
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  return kc.makeApiClient(k8s.CustomObjectsApi);
}
export function mapArgoStatus(app: any) {
  const status = app.status || {};
  const resources = Array.isArray(status.resources) ? status.resources : [];
  return {
    branch: app.spec?.source?.targetRevision || 'HEAD',
    syncStatus: status.sync?.status || 'Unknown', healthStatus: status.health?.status || 'Unknown',
    revision: status.sync?.revision || 'Unknown', sync: status.sync || {},
    syncTime: status.operationState?.finishedAt || status.reconciledAt || null,
    conditions: status.conditions || [],
    operationState: status.operationState ? {
      phase: status.operationState.phase, message: status.operationState.message,
      startedAt: status.operationState.startedAt, finishedAt: status.operationState.finishedAt,
    } : null,
    resources: {
      total: resources.length,
      synced: resources.filter((r: any) => r.status === 'Synced').length,
      outOfSync: resources.filter((r: any) => r.status === 'OutOfSync').length,
      healthy: resources.filter((r: any) => r.health?.status === 'Healthy').length,
      degraded: resources.filter((r: any) => r.health?.status === 'Degraded').length,
    },
  };
}

/** JSON Patch with resourceVersion precondition avoids replacing an operation raced by another actor. */
export async function actOnArgoApp(client: k8s.CustomObjectsApi, name: string, action: 'refresh' | 'sync', username: string) {
  const response: any = await client.getNamespacedCustomObject({ ...argoResource, name });
  const app = response.body || response;
  if (action === 'sync' && (app.operation || ['Running', 'Terminating'].includes(app.status?.operationState?.phase))) {
    const error: any = new Error('An ArgoCD operation is already in progress');
    error.statusCode = 409;
    throw error;
  }
  const patch: any[] = [{ op: 'test', path: '/metadata/resourceVersion', value: app.metadata.resourceVersion }];
  if (action === 'refresh') {
    if (!app.metadata.annotations) patch.push({ op: 'add', path: '/metadata/annotations', value: {} });
    patch.push({ op: 'add', path: '/metadata/annotations/argocd.argoproj.io~1refresh', value: 'hard' });
  } else {
    patch.push({ op: 'add', path: '/operation', value: {
      initiatedBy: { username }, sync: { revision: app.spec?.source?.targetRevision || 'HEAD' },
    } });
  }
  await client.patchNamespacedCustomObject({ ...argoResource, name, body: patch });
}
