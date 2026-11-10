/**
 * Kubernetes reads for the live topology graph (issue #31).
 *
 * Read-only and namespaced: every call lists one project namespace (granted by
 * the per-namespace `platform-namespace-baseline` binding) plus a single named
 * GET of the ArgoCD Application in `argocd`. No cluster-wide lists, and Secrets /
 * ConfigMaps are never listed — their nodes come from references (see
 * referencedConfigObjects) so no secret value is ever read.
 */
import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from './kube-config';
import { TopologySources, referencedConfigObjects } from './topology';

export interface TopologyFetchResult {
  sources: TopologySources;
  /** Per-list failures (e.g. cert-manager CRD absent, RBAC not yet bootstrapped). */
  warnings: string[];
  /**
   * The environment was never deployed: no Argo Application and the namespace
   * baseline (RBAC) does not exist yet, so lists are forbidden. Shown as an
   * empty "not deployed yet" state instead of a list of 403 errors.
   */
  notDeployed?: boolean;
}

let clients: {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
  net: k8s.NetworkingV1Api;
  custom: k8s.CustomObjectsApi;
} | null = null;

function api() {
  if (!clients) {
    const kc = new k8s.KubeConfig();
    loadKubeConfig(kc);
    clients = {
      core: kc.makeApiClient(k8s.CoreV1Api),
      apps: kc.makeApiClient(k8s.AppsV1Api),
      net: kc.makeApiClient(k8s.NetworkingV1Api),
      custom: kc.makeApiClient(k8s.CustomObjectsApi),
    };
  }
  return clients;
}

function statusCode(err: any): number | undefined {
  return err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code;
}

function shortError(err: any): string {
  const code = statusCode(err);
  const msg = String(err?.body?.message || err?.message || err || 'error').split('\n')[0].slice(0, 200);
  return code ? `${code}: ${msg}` : msg;
}

export async function fetchTopologySources(namespace: string, appName: string): Promise<TopologyFetchResult> {
  const { core, apps, net, custom } = api();
  const warnings: string[] = [];

  const items = (r: any) => (r?.items || r?.body?.items || []) as any[];
  const list = async (label: string, fn: () => Promise<any>, optional404 = false): Promise<any[] | null> => {
    try {
      return items(await fn());
    } catch (err: any) {
      if (optional404 && statusCode(err) === 404) return [];
      warnings.push(`${label}: ${shortError(err)}`);
      return null;
    }
  };

  const [app, deployments, replicaSets, pods, services, ingresses, certificates, pvcs, events] = await Promise.all([
    custom
      .getNamespacedCustomObject({ group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications', name: appName })
      .then((r: any) => ({ app: r?.body || r, missing: false, error: null as string | null }))
      .catch((err: any) => ({ app: null, missing: statusCode(err) === 404, error: statusCode(err) === 404 ? `ArgoCD Application '${appName}' not found` : shortError(err) })),
    list('deployments', () => apps.listNamespacedDeployment({ namespace })),
    list('replicasets', () => apps.listNamespacedReplicaSet({ namespace })),
    list('pods', () => core.listNamespacedPod({ namespace })),
    list('services', () => core.listNamespacedService({ namespace })),
    list('ingresses', () => net.listNamespacedIngress({ namespace })),
    // cert-manager may be absent (404 = CRD not installed).
    list('certificates', () => custom.listNamespacedCustomObject({ group: 'cert-manager.io', version: 'v1', namespace, plural: 'certificates' }), true),
    list('persistentvolumeclaims', () => core.listNamespacedPersistentVolumeClaim({ namespace })),
    list('events', () => core.listNamespacedEvent({ namespace })),
  ]);

  // Never deployed: Argo app absent and every failed list is a 403 (the per-namespace
  // RBAC binding is created on first deploy). Nothing to show, nothing went wrong.
  if (
    !app.app && app.missing && deployments === null && replicaSets === null
    && (pods || []).length === 0 && (services || []).length === 0
    && warnings.length > 0 && warnings.every((w) => /\b403\b/.test(w))
  ) {
    return {
      sources: {
        namespace, appName, app: null, appError: null,
        deployments: [], replicaSets: [], pods: [], services: [], ingresses: [], certificates: [],
        pvcs: [], configMaps: [], secrets: [], events: [],
      },
      warnings: [],
      notDeployed: true,
    };
  }

  const core3 = [deployments, pods, services];
  if (core3.every((x) => x === null) && !app.app) {
    const e: any = new Error(`Kubernetes unavailable for namespace ${namespace}: ${warnings[0] || app.error || 'unknown error'}`);
    e.status = 503;
    throw e;
  }

  const live = {
    pods: pods || [],
    ingresses: ingresses || [],
    certificates: certificates || [],
  };
  const refs = referencedConfigObjects(live);

  return {
    sources: {
      namespace,
      appName,
      app: app.app,
      appError: app.error,
      deployments: deployments || [],
      replicaSets: replicaSets || [],
      pods: live.pods,
      services: services || [],
      ingresses: live.ingresses,
      certificates: live.certificates,
      pvcs: pvcs || [],
      configMaps: refs.configMaps,
      secrets: refs.secrets,
      events: events || [],
    },
    warnings,
  };
}
