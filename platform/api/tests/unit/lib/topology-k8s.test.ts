/** fetchTopologySources: never-deployed environments vs real failures (#31, VM finding). */
const forbidden = () => Promise.reject(Object.assign(new Error('HTTP-Code: 403'), { code: 403 }));
const notFound = () => Promise.reject(Object.assign(new Error('HTTP-Code: 404'), { code: 404 }));
const ok = () => Promise.resolve({ items: [] });
let mockMode: 'never-deployed' | 'argo-missing-but-listable' | 'partial' = 'never-deployed';

jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: () => undefined }));
jest.mock('@kubernetes/client-node', () => {
  class KubeConfig { makeApiClient(cls: any) { return new cls(); } }
  const list = (name: string) => () => {
    if (mockMode === 'never-deployed') return name === 'pods' || name === 'services' ? ok() : forbidden();
    if (mockMode === 'partial') return name === 'events' ? forbidden() : ok();
    return ok();
  };
  class CoreV1Api {
    listNamespacedPod = list('pods');
    listNamespacedService = list('services');
    listNamespacedPersistentVolumeClaim = list('pvcs');
    listNamespacedEvent = list('events');
  }
  class AppsV1Api { listNamespacedDeployment = list('deployments'); listNamespacedReplicaSet = list('replicasets'); }
  class NetworkingV1Api { listNamespacedIngress = list('ingresses'); }
  class CustomObjectsApi {
    getNamespacedCustomObject = () => notFound();
    listNamespacedCustomObject = list('certificates');
  }
  return { KubeConfig, CoreV1Api, AppsV1Api, NetworkingV1Api, CustomObjectsApi };
});

import { fetchTopologySources } from '../../../src/lib/topology-k8s';

describe('fetchTopologySources', () => {
  it('reports a never-deployed environment as notDeployed without 403 warnings', async () => {
    mockMode = 'never-deployed';
    const r = await fetchTopologySources('shop-staging-ns', 'shop-staging-ns');
    expect(r.notDeployed).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.sources.appError).toBeNull();
    expect(r.sources.pods).toEqual([]);
  });

  it('keeps warnings when only some lists fail', async () => {
    mockMode = 'partial';
    const r = await fetchTopologySources('ns', 'ns');
    expect(r.notDeployed).toBeFalsy();
    expect(r.warnings.join(' ')).toMatch(/events: .*403/);
    expect(r.sources.appError).toMatch(/not found/);
  });

  it('a missing Argo app with listable objects is not "not deployed"', async () => {
    mockMode = 'argo-missing-but-listable';
    const r = await fetchTopologySources('ns', 'ns');
    expect(r.notDeployed).toBeFalsy();
    expect(r.warnings).toEqual([]);
  });
});
