const mockApps = { listNamespacedDeployment: jest.fn(), patchNamespacedDeploymentScale: jest.fn(), deleteNamespacedDeployment: jest.fn() };
const mockCustom = { getNamespacedCustomObject: jest.fn(), deleteNamespacedCustomObject: jest.fn() };
jest.mock('@kubernetes/client-node', () => ({ AppsV1Api: 'apps', CoreV1Api: 'core', CustomObjectsApi: 'custom', KubeConfig: class {
  makeApiClient(type: string) { return type === 'apps' ? mockApps : type === 'custom' ? mockCustom : {}; }
} }));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
import { operateProjectWorkloads } from '../../../src/lib/k8s';
beforeEach(() => {
  jest.clearAllMocks();
  mockApps.listNamespacedDeployment.mockResolvedValue({ items: [{ metadata: { name: 'source-e' } }, { metadata: { name: 'another-app' } }] });
});
it('scales only the selected source workload without requiring an Argo Application', async () => {
  await operateProjectWorkloads('project-staging', 'source-e', 'scale', 2, true);
  expect(mockApps.patchNamespacedDeploymentScale).toHaveBeenCalledTimes(1);
  expect(mockApps.patchNamespacedDeploymentScale).toHaveBeenCalledWith({ namespace: 'project-staging', name: 'source-e', body: { spec: { replicas: 2 } } });
  expect(mockCustom.getNamespacedCustomObject).not.toHaveBeenCalled();
});
it('terminates only the selected source workload without deleting a GitOps reconciler', async () => {
  await operateProjectWorkloads('project-staging', 'source-e', 'terminate', undefined, true);
  expect(mockApps.deleteNamespacedDeployment).toHaveBeenCalledTimes(1);
  expect(mockApps.deleteNamespacedDeployment).toHaveBeenCalledWith({ namespace: 'project-staging', name: 'source-e' });
  expect(mockCustom.deleteNamespacedCustomObject).not.toHaveBeenCalled();
});
