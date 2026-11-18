jest.mock('../../../src/lib/namespace-baseline', () => ({ ensureProjectNamespace: jest.fn().mockResolvedValue({}) }));
const mockApi: any = { listNamespace: jest.fn(), listNode: jest.fn() };
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: class { loadFromCluster() {} makeApiClient() { return mockApi; } }, CoreV1Api: class {}, AppsV1Api: class {}, CustomObjectsApi: class {}, NetworkingV1Api: class {} }));
import { clusterRead, checkK8sConnection, getK8sNodes } from '../../../src/lib/k8s';

beforeEach(() => jest.clearAllMocks());

describe('clusterRead (HA: one apiserver down)', () => {
  it('retries once when the first request fails on a dead server', async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValueOnce('ok');
    await expect(clusterRead(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up on a hung request after the timeout and retries', async () => {
    const fn = jest.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce('ok');
    await expect(clusterRead(fn, 2, 20)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry client errors such as RBAC denials', async () => {
    const fn = jest.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { code: 403 }));
    await expect(clusterRead(fn)).rejects.toThrow('forbidden');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fails after the last attempt', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('down'));
    await expect(clusterRead(fn, 2, 20)).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

it('reports the cluster connected and lists servers when only the first call hits a dead server', async () => {
  mockApi.listNamespace.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce({ items: [] });
  mockApi.listNode.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce({ items: [
    { metadata: { name: 'a', labels: { 'node-role.kubernetes.io/control-plane': 'true' } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
    { metadata: { name: 'b', labels: {} }, status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } },
  ] });
  await expect(checkK8sConnection()).resolves.toBe(true);
  const nodes = await getK8sNodes();
  expect(nodes.map((n) => [n.name, n.status])).toEqual([['a', 'Ready'], ['b', 'NotReady']]);
});
