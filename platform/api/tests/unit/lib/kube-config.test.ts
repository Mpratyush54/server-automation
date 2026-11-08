import { inCluster, loadKubeConfig } from '../../../src/lib/kube-config';

function fakeKc() {
  const calls: string[] = [];
  return { calls, loadFromCluster: () => { calls.push('cluster'); }, loadFromDefault: () => { calls.push('default'); } };
}

describe('loadKubeConfig', () => {
  it('uses the in-cluster ServiceAccount only when Kubernetes injected its service env', () => {
    const kc = fakeKc();
    loadKubeConfig(kc, { KUBERNETES_SERVICE_HOST: '10.43.0.1', KUBERNETES_SERVICE_PORT: '443' });
    expect(kc.calls).toEqual(['cluster']);
  });

  it('falls back to KUBECONFIG/~/.kube/config outside a pod (loadFromCluster does not throw there)', () => {
    // Regression: try { loadFromCluster() } catch { loadFromDefault() } never fell back,
    // because loadFromCluster silently produced https://undefined:undefined.
    const kc = fakeKc();
    loadKubeConfig(kc, {});
    expect(kc.calls).toEqual(['default']);
    expect(inCluster({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(false);
  });

  it('tolerates a missing local kubeconfig', () => {
    const kc = { loadFromCluster: jest.fn(), loadFromDefault: () => { throw new Error('no config'); } };
    expect(() => loadKubeConfig(kc, {})).not.toThrow();
  });
});
