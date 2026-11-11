const readNamespacedConfigMap = jest.fn();
const patchNamespacedConfigMap = jest.fn();

jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromCluster: jest.fn(),
    loadFromDefault: jest.fn(),
    makeApiClient: () => ({ readNamespacedConfigMap, patchNamespacedConfigMap }),
  })),
  CoreV1Api: function CoreV1Api() {},
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
  setHeaderOptions: (key: string, value: string) => ({ header: [key, value] }),
}));

import { kubeOriginsApi } from '../../../src/lib/telemetry-origins';

beforeEach(() => {
  readNamespacedConfigMap.mockReset();
  patchNamespacedConfigMap.mockReset();
});

describe('kubeOriginsApi', () => {
  it('reads origins.json from monitoring/telemetry-origins', async () => {
    readNamespacedConfigMap.mockResolvedValue({ data: { 'origins.json': '["https://a.example.org"]' } });
    expect(await kubeOriginsApi().read()).toBe('["https://a.example.org"]');
    expect(readNamespacedConfigMap).toHaveBeenCalledWith({ name: 'telemetry-origins', namespace: 'monitoring' });
  });

  it('returns "" when the key is absent and null when the ConfigMap is missing', async () => {
    readNamespacedConfigMap.mockResolvedValueOnce({ metadata: {} });
    expect(await kubeOriginsApi().read()).toBe('');
    readNamespacedConfigMap.mockRejectedValueOnce(Object.assign(new Error('nf'), { code: 404 }));
    expect(await kubeOriginsApi().read()).toBeNull();
    readNamespacedConfigMap.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { code: 403 }));
    await expect(kubeOriginsApi().read()).rejects.toThrow('forbidden');
  });

  it('merge-patches only the origins.json key', async () => {
    patchNamespacedConfigMap.mockResolvedValue({});
    await kubeOriginsApi('obs').write('["https://a.example.org"]');
    expect(patchNamespacedConfigMap).toHaveBeenCalledWith(
      { name: 'telemetry-origins', namespace: 'obs', body: { data: { 'origins.json': '["https://a.example.org"]' } } },
      { header: ['Content-Type', 'application/merge-patch+json'] },
    );
  });
});
