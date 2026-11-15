const mockApps = { readNamespacedDeployment: jest.fn(), createNamespacedDeployment: jest.fn(), replaceNamespacedDeployment: jest.fn() };
const mockCore = { readNamespacedSecret: jest.fn(), createNamespacedSecret: jest.fn(), replaceNamespacedSecret: jest.fn(), readNamespacedService: jest.fn(), createNamespacedService: jest.fn() };
jest.mock('@kubernetes/client-node', () => ({ AppsV1Api: 'apps', CoreV1Api: 'core', KubeConfig: class { makeApiClient(type: string) { return type === 'apps' ? mockApps : mockCore; } } }));
jest.mock('../../../src/lib/kube-config', () => ({ loadKubeConfig: jest.fn() }));
import crypto from 'crypto';
import { applySourceWorkload, sourceWorkloadReady } from '../../../src/lib/source-deploy';
import { pullCredential, setRegistrySignerForTests } from '../../../src/lib/registry-token';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
beforeAll(() => { setRegistrySignerForTests(privateKey); process.env.BUILDS_REGISTRY = 'registry.example.com'; });
afterAll(() => setRegistrySignerForTests(null));
beforeEach(() => {
  jest.resetAllMocks();
  mockCore.readNamespacedService.mockRejectedValue({ code: 404 });
});
it('creates an authenticated deployment and a service when no manifests exist', async () => {
  mockApps.readNamespacedDeployment.mockRejectedValue({ code: 404 });
  await applySourceWorkload('ns', 'app', 'registry/p@sha256:abc', 'p', 'staging');
  expect(mockCore.createNamespacedSecret.mock.calls[0][0].body.type).toBe('kubernetes.io/dockerconfigjson');
  expect(mockCore.readNamespacedSecret).not.toHaveBeenCalledWith(expect.objectContaining({ namespace: 'builds' }));
  expect(mockApps.createNamespacedDeployment.mock.calls[0][0].body.spec.template.spec.containers[0].image).toContain('@sha256:abc');
  expect(mockCore.createNamespacedService.mock.calls[0][0].body.spec.ports[0].targetPort).toBe(8080);
});
it('uses optimistic concurrency and refuses a workload owned by someone else', async () => {
  mockApps.readNamespacedDeployment.mockResolvedValue({ metadata: { resourceVersion: '3', labels: { 'platform.io/project': 'p' } } });
  await applySourceWorkload('ns', 'app', 'registry/p@sha256:abc', 'p', 'staging');
  expect(mockApps.replaceNamespacedDeployment.mock.calls[0][0].body.metadata.resourceVersion).toBe('3');
  mockApps.readNamespacedDeployment.mockResolvedValue({ metadata: { labels: { 'platform.io/project': 'other' } } });
  await expect(applySourceWorkload('ns', 'app', 'registry/p@sha256:abc', 'p', 'staging')).rejects.toThrow('already in use');
});
it('waits for the new pod rather than accepting availability from the old replica', async () => {
  const dep = { metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, availableReplicas: 1, readyReplicas: 1, updatedReplicas: 1, replicas: 2 } };
  mockApps.readNamespacedDeployment.mockResolvedValue(dep);
  expect(await sourceWorkloadReady('ns', 'app')).toBe(false);
  dep.status.replicas = 1;
  expect(await sourceWorkloadReady('ns', 'app')).toBe(true);
  dep.status.observedGeneration = 1;
  expect(await sourceWorkloadReady('ns', 'app')).toBe(false);
});

it('writes a pull-only credential for this project only, never a shared push credential', async () => {
  mockApps.readNamespacedDeployment.mockRejectedValue({ code: 404 });
  await applySourceWorkload('ns-a', 'app', 'registry/p@sha256:abc', 'project-a', 'staging');
  await applySourceWorkload('ns-b', 'app', 'registry/p@sha256:abc', 'project-b', 'staging');
  const configs = mockCore.createNamespacedSecret.mock.calls.map((c: any) => JSON.parse(Buffer.from(c[0].body.data['.dockerconfigjson'], 'base64').toString()));
  const a = configs[0].auths['registry.example.com'];
  const b = configs[1].auths['registry.example.com'];
  expect(a.username).toBe('pull.project-a');
  expect(a.password).toBe((await pullCredential('project-a')).password);
  expect(b.username).toBe('pull.project-b');
  expect(a.password).not.toBe(b.password);
  expect(Object.keys(configs[0].auths)).toEqual(['registry.example.com']);
});

it('sets the release metadata in the workload itself (no second rollout, no StatefulSet access needed)', async () => {
  const { sourceWorkload } = await import('../../../src/lib/source-deploy');
  const env = sourceWorkload('ns', 'app', 'registry.example/p/e@sha256:' + 'a'.repeat(64), 'p1', 'staging', 'c'.repeat(40)).spec.template.spec.containers[0].env;
  expect(env).toEqual(expect.arrayContaining([{ name: 'PORT', value: '8080' }, { name: 'PLATFORM_RELEASE', value: 'c'.repeat(40) },
    { name: 'OTEL_SERVICE_VERSION', value: 'c'.repeat(40) }]));
  const plain = sourceWorkload('ns', 'app', 'img', 'p1', 'staging').spec.template.spec.containers[0].env;
  expect(plain).toEqual([{ name: 'PORT', value: '8080' }]);
});
