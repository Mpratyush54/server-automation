jest.mock('@kubernetes/client-node', () => ({ KubeConfig: jest.fn(), CustomObjectsApi: jest.fn() }));
import { mapArgoStatus, actOnArgoApp } from '../../src/lib/argocd';

it('preserves Argo conditions and operation errors verbatim, revision and resource totals', () => {
  const conditions = [{ type: 'ComparisonError', message: 'path not found: k8s\ncheck repo' }];
  const result = mapArgoStatus({ spec: { source: { targetRevision: 'master' } }, status: {
    conditions, sync: { status: 'OutOfSync', revision: 'abc123' },
    operationState: { phase: 'Failed', message: 'manifest generation error' },
    resources: [{ status: 'Synced', health: { status: 'Healthy' } }, { status: 'OutOfSync', health: { status: 'Degraded' } }],
  } });
  expect(result.conditions).toEqual(conditions);
  expect(result.operationState).toMatchObject({ phase: 'Failed', message: 'manifest generation error' });
  expect(result).toMatchObject({ branch: 'master', revision: 'abc123', sync: { revision: 'abc123' }, resources: { total: 2, synced: 1, outOfSync: 1, degraded: 1, healthy: 1 } });
});
it('handles an Application with no status yet', () => {
  expect(mapArgoStatus({})).toMatchObject({ conditions: [], operationState: null, resources: { total: 0 } });
});
it('hard-refreshes with JSON Patch and preserves existing annotations', async () => {
  const client: any = { getNamespacedCustomObject: jest.fn().mockResolvedValue({ metadata: { resourceVersion: '5', annotations: { other: 'keep' } } }), patchNamespacedCustomObject: jest.fn() };
  await actOnArgoApp(client, 'demo-dev', 'refresh', 'user');
  expect(client.patchNamespacedCustomObject).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo-dev', body: [
    { op: 'test', path: '/metadata/resourceVersion', value: '5' },
    { op: 'add', path: '/metadata/annotations/argocd.argoproj.io~1refresh', value: 'hard' },
  ] }));
});
it('syncs the current target revision using operation and actor identity', async () => {
  const client: any = { getNamespacedCustomObject: jest.fn().mockResolvedValue({ metadata: { resourceVersion: '5' }, spec: { source: { targetRevision: 'trunk' } } }), patchNamespacedCustomObject: jest.fn() };
  await actOnArgoApp(client, 'demo-dev', 'sync', 'user');
  expect(client.patchNamespacedCustomObject.mock.calls[0][0].body[1]).toEqual({ op: 'add', path: '/operation', value: { initiatedBy: { username: 'user' }, sync: { revision: 'trunk' } } });
});
it('refuses to overwrite an active operation', async () => {
  const client: any = { getNamespacedCustomObject: jest.fn().mockResolvedValue({ operation: { sync: {} } }), patchNamespacedCustomObject: jest.fn() };
  await expect(actOnArgoApp(client, 'demo-dev', 'sync', 'user')).rejects.toMatchObject({ statusCode: 409 });
  expect(client.patchNamespacedCustomObject).not.toHaveBeenCalled();
});
