jest.mock('../../../src/lib/namespace-baseline', () => ({ ensureProjectNamespace: jest.fn().mockResolvedValue({}) }));
const mockApi: any = {
  readNamespacedDeployment: jest.fn(),
  getNamespacedCustomObject: jest.fn(), replaceNamespacedCustomObject: jest.fn(),
  listNamespacedDeployment: jest.fn(), patchNamespacedDeployment: jest.fn(), patchNamespacedDeploymentScale: jest.fn(),
  deleteNamespacedDeployment: jest.fn(), deleteNamespacedCustomObject: jest.fn(),
  deleteNamespacedService: jest.fn(), deleteNamespacedIngress: jest.fn(),
  createNamespace: jest.fn(), createNamespacedDeployment: jest.fn(), createNamespacedService: jest.fn(), createNamespacedIngress: jest.fn(),
};
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: class { loadFromCluster() {} makeApiClient() { return mockApi; } }, CoreV1Api: class {}, AppsV1Api: class {}, CustomObjectsApi: class {}, NetworkingV1Api: class {} }));
import { operateProjectWorkloads, deployK8sPreview, terminateK8sPreview, previewResourceName } from '../../../src/lib/k8s';
beforeEach(() => {
  jest.clearAllMocks();
  for (const method of Object.values(mockApi) as jest.Mock[]) method.mockResolvedValue({});
  mockApi.readNamespacedDeployment.mockResolvedValue({ metadata: { labels: { 'platform-project-id': 'id-a' } } });
  mockApi.getNamespacedCustomObject.mockResolvedValue({ spec: {} });
  mockApi.listNamespacedDeployment.mockResolvedValue({ items: [{ metadata: { name: 'web' } }] });
});
it('restarts the discovered workload using the Kubernetes API', async () => {
  await operateProjectWorkloads('project-ns', 'project-app', 'restart');
  expect(mockApi.patchNamespacedDeployment).toHaveBeenCalledWith(expect.objectContaining({ name: 'web', namespace: 'project-ns', body: expect.any(Array) }), expect.anything());
});
it('scales the discovered workload using the Kubernetes scale API', async () => {
  await operateProjectWorkloads('project-ns', 'project-app', 'scale', 3);
  expect(mockApi.replaceNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ spec: expect.objectContaining({ ignoreDifferences: expect.arrayContaining([expect.objectContaining({ jsonPointers: ['/spec/replicas'] })]) }) }) }));
  expect(mockApi.patchNamespacedDeploymentScale).toHaveBeenCalledWith({ name: 'web', namespace: 'project-ns', body: { spec: { replicas: 3 } } });
});
it('deletes the Argo reconciler and workload when terminating', async () => {
  await operateProjectWorkloads('project-ns', 'project-app', 'terminate');
  expect(mockApi.deleteNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ name: 'project-app', plural: 'applications' }));
  expect(mockApi.deleteNamespacedDeployment).toHaveBeenCalledWith({ name: 'web', namespace: 'project-ns' });
});
it('propagates API failure instead of claiming termination', async () => {
  mockApi.deleteNamespacedCustomObject.mockRejectedValueOnce(new Error('forbidden'));
  await expect(operateProjectWorkloads('project-ns', 'project-app', 'terminate')).rejects.toThrow('forbidden');
  expect(mockApi.deleteNamespacedDeployment).not.toHaveBeenCalled();
});
it('gives identical branches in different projects distinct preview workload names', async () => {
  await deployK8sPreview('alpha.beta', 'feature/test', 'nginx:alpine', 'id-a');
  await deployK8sPreview('alpha-beta', 'feature/test', 'nginx:alpine', 'id-b');
  const names = mockApi.createNamespacedDeployment.mock.calls.map((call: any) => call[0].body.metadata.name);
  expect(names[0]).not.toBe(names[1]);
  const namespaces = mockApi.createNamespacedDeployment.mock.calls.map((call: any) => call[0].namespace);
  expect(namespaces[0]).not.toBe(namespaces[1]);
  expect(namespaces[0]).not.toBe('preview');
  expect(mockApi.createNamespacedDeployment.mock.calls[0][0].body.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
  expect(previewResourceName('id-a', 'feature/a.b')).not.toBe(previewResourceName('id-a', 'feature/a-b'));
});
it('uses the stored preview name, including for existing infrastructure', async () => {
  expect(await terminateK8sPreview('feature/test', 'id-a', 'preview-legacy-recorded')).toBe(true);
  expect(mockApi.deleteNamespacedDeployment).toHaveBeenCalledWith({ name: 'preview-legacy-recorded', namespace: 'preview' });
  expect(mockApi.deleteNamespacedIngress).toHaveBeenCalled();
});
it('fails closed for unrecorded legacy previews and for API errors', async () => {
  await expect(terminateK8sPreview('feature/test', 'id-a')).rejects.toThrow(/Recorded/);
  mockApi.deleteNamespacedDeployment.mockRejectedValueOnce(new Error('offline'));
  expect(await terminateK8sPreview('feature/test', 'id-a', previewResourceName('id-a', 'feature/test'))).toBe(false);
});

it('rejects stored preview names owned by another project', async () => {
  mockApi.readNamespacedDeployment.mockResolvedValueOnce({ metadata: { labels: { 'platform-project-id': 'foreign' } } });
  expect(await terminateK8sPreview('feature/test', 'id-a', 'preview-foreign')).toBe(false);
  expect(mockApi.deleteNamespacedDeployment).not.toHaveBeenCalled();
});
