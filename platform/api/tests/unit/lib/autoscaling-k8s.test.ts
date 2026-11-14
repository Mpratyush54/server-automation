jest.mock('@kubernetes/client-node', () => ({}));
import { applyEnvironmentAutoscaling, readEnvironmentAutoscaling } from '../../../src/lib/autoscaling-k8s';
import { autoscalingNamespace, defaultAutoscaling } from '../../../src/lib/autoscaling';

const env: any = { id: 'env-id', projectId: 'project-id', namespace: 'project-preview', name: 'preview' };
env.namespace = autoscalingNamespace(env);
const settings = { ...defaultAutoscaling, enabled: true };
function cluster(keda = false) {
  const store = new Map<string, any>();
  const d = { metadata: { name: 'web', uid: 'web-uid', labels: { 'platform-project-id': env.projectId } },
    spec: { replicas: 1, template: { metadata: { labels: { app: 'web' } }, spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } } }] } } }, status: { replicas: 2, readyReplicas: 1 } };
  const ingress = { metadata: { name: 'web' }, spec: { rules: [{ host: 'preview.example.org', http: { paths: [{ path: '/', backend: { service: { name: 'web', port: { number: 80 } } } }] } }] } };
  const read = jest.fn(async (args: any) => {
    const obj = store.get(`${args.plural || 'hpa'}/${args.name}`);
    if (!obj) throw { code: 404 };
    return structuredClone(obj);
  });
  const write = jest.fn(async ({ body, plural }: any) => { store.set(`${plural || 'hpa'}/${body.metadata.name}`, structuredClone(body)); return body; });
  const remove = jest.fn(async (args: any) => store.delete(`${args.plural || 'hpa'}/${args.name}`));
  const c: any = {
    core: { readNamespace: jest.fn().mockResolvedValue({ metadata: { labels: { 'platform.io/project': env.projectId, 'platform.io/env': env.name } } }),
      listNamespacedResourceQuota: jest.fn().mockResolvedValue({ items: [{ spec: { hard: { pods: '10' } } }] }),
      listNamespacedPod: jest.fn().mockResolvedValue({ items: [] }),
      listNamespacedService: jest.fn().mockResolvedValue({ items: [{ metadata: { name: 'web' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } }] }),
      readNamespacedService: (a: any) => read({ ...a, plural: 'services' }), createNamespacedService: (a: any) => write({ ...a, plural: 'services' }), replaceNamespacedService: (a: any) => write({ ...a, plural: 'services' }), deleteNamespacedService: (a: any) => remove({ ...a, plural: 'services' }) },
    apps: { listNamespacedDeployment: jest.fn().mockResolvedValue({ items: [d] }), patchNamespacedDeploymentScale: jest.fn() },
    hpa: { listNamespacedHorizontalPodAutoscaler: jest.fn().mockResolvedValue({ items: [] }), readNamespacedHorizontalPodAutoscaler: read,
      createNamespacedHorizontalPodAutoscaler: write, replaceNamespacedHorizontalPodAutoscaler: write, deleteNamespacedHorizontalPodAutoscaler: remove },
    custom: { getNamespacedCustomObject: read, createNamespacedCustomObject: write, replaceNamespacedCustomObject: write, deleteNamespacedCustomObject: remove, listNamespacedCustomObject: jest.fn().mockResolvedValue({ items: [] }) },
    network: { listNamespacedIngress: jest.fn().mockImplementation(async () => ({ items: [structuredClone(ingress)] })), replaceNamespacedIngress: jest.fn(async ({ body }: any) => Object.assign(ingress, body)) },
    extensions: { readCustomResourceDefinition: jest.fn(async () => { if (!keda) throw { code: 404 }; return {}; }) },
  };
  return { c, store, d, ingress, write, remove };
}

it('creates, updates and removes an owned HPA without KEDA', async () => {
  const { c, store, write } = cluster();
  await applyEnvironmentAutoscaling(env, settings, c);
  expect(store.get('hpa/web-autoscaling').spec.maxReplicas).toBe(3);
  await applyEnvironmentAutoscaling(env, { ...settings, maxReplicas: 4 }, c);
  expect(store.get('hpa/web-autoscaling').spec.maxReplicas).toBe(4);
  await applyEnvironmentAutoscaling(env, { ...settings, enabled: false }, c);
  expect(store.has('hpa/web-autoscaling')).toBe(false);
  expect(write).toHaveBeenCalledTimes(2);
});
it('rejects missing KEDA with 409 before writing resources', async () => {
  const { c, write } = cluster();
  await expect(applyEnvironmentAutoscaling(env, { ...settings, targetRps: 10 }, c)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('full profile') });
  expect(write).not.toHaveBeenCalled();
});
it('uses the immutable preview namespace rather than the environment record namespace', async () => {
  const { c } = cluster();
  const result = await readEnvironmentAutoscaling({ ...env, namespace: 'legacy-record-namespace' }, c);
  expect(result.namespace).toBe(env.namespace);
  expect(c.apps.listNamespacedDeployment).toHaveBeenCalledWith({ namespace: env.namespace });
});
it('uses the ingress Service name for request-rate scaling', async () => {
  const { c, store, ingress } = cluster(true);
  c.core.listNamespacedService.mockResolvedValue({ items: [{ metadata: { name: 'frontend' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } }] });
  ingress.spec.rules[0].http.paths[0].backend.service.name = 'frontend';
  await applyEnvironmentAutoscaling(env, { ...settings, targetRps: 10 }, c);
  expect(store.get('scaledobjects/web-autoscaling').spec.triggers.find((t: any) => t.type === 'prometheus').metadata.query).toContain('frontend|web-autoscaling');
});
it('routes previews through the activator and restores the original backend on disable', async () => {
  const { c, store, ingress, d } = cluster(true);
  await applyEnvironmentAutoscaling(env, { ...settings, minReplicas: 0 }, c);
  expect(store.has('httpscaledobjects/web-autoscaling')).toBe(true);
  expect(store.get('scaledobjects/web-autoscaling').spec.minReplicaCount).toBe(0);
  expect(ingress.spec.rules[0].http.paths[0].backend.service).toEqual({ name: 'web-autoscaling', port: { number: 8080 } });
  expect(store.get('services/web-autoscaling').spec.externalName).toBe('keda-add-ons-http-interceptor-proxy.keda.svc.cluster.local');
  d.spec.replicas = 0;
  await applyEnvironmentAutoscaling(env, { ...settings, enabled: false }, c);
  expect(c.apps.patchNamespacedDeploymentScale).toHaveBeenCalledWith({ namespace: env.namespace, name: 'web', body: { spec: { replicas: 1 } } });
  expect(ingress.spec.rules[0].http.paths[0].backend.service).toEqual({ name: 'web', port: { number: 80 } });
  expect(store.has('scaledobjects/web-autoscaling')).toBe(false);
});
it('rejects quota overflow before applying any scaling resources', async () => {
  const { c, write } = cluster();
  c.core.listNamespacedResourceQuota.mockResolvedValue({ items: [{ spec: { hard: { pods: '2' } } }] });
  await expect(applyEnvironmentAutoscaling(env, settings, c)).rejects.toThrow(/ResourceQuota/);
  expect(write).not.toHaveBeenCalled();
});
it('refuses foreign namespace or controller ownership and propagates cluster failures', async () => {
  const { c, write } = cluster();
  c.core.readNamespace.mockResolvedValueOnce({ metadata: { labels: {} } });
  await expect(applyEnvironmentAutoscaling(env, settings, c)).rejects.toMatchObject({ status: 409 });
  c.hpa.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ items: [{ metadata: {}, spec: { scaleTargetRef: { name: 'web' } } }] });
  await expect(applyEnvironmentAutoscaling(env, settings, c)).rejects.toThrow(/managed elsewhere/);
  expect(write).not.toHaveBeenCalled();
  c.extensions.readCustomResourceDefinition.mockRejectedValue({ code: 403 });
  await expect(readEnvironmentAutoscaling(env, c)).rejects.toMatchObject({ code: 403 });
});
it('returns current replica counts and HPA conditions', async () => {
  const { c } = cluster();
  const status = { conditions: [{ type: 'ScalingActive', status: 'True' }] };
  c.hpa.listNamespacedHorizontalPodAutoscaler.mockResolvedValue({ items: [{ spec: { scaleTargetRef: { name: 'web' } }, status }] });
  expect((await readEnvironmentAutoscaling(env, c)).workloads).toEqual([{ name: 'web', currentReplicas: 2, readyReplicas: 1, hpa: status }]);
});
it('keeps Argo from resetting replicas and deduplicates the ignore rule', async () => {
  const { c, store } = cluster();
  const production = { ...env, name: 'production' };
  c.core.readNamespace.mockResolvedValue({ metadata: { labels: { 'platform.io/project': env.projectId, 'platform.io/env': 'production' } } });
  store.set(`applications/${env.namespace}`, { metadata: { name: env.namespace }, spec: { ignoreDifferences: [{ group: 'apps', kind: 'Deployment', namespace: env.namespace, jsonPointers: ['/spec/replicas'] }] } });
  await applyEnvironmentAutoscaling(production, settings, c);
  await applyEnvironmentAutoscaling(production, settings, c);
  const app = store.get(`applications/${env.namespace}`);
  expect(app.spec.ignoreDifferences).toHaveLength(1);
  expect(app.spec.syncPolicy.syncOptions).toEqual(['RespectIgnoreDifferences=true']);
});
it('does not create another controller while a foreign ScaledObject is awaiting its HPA', async () => {
  const { c, write } = cluster(true);
  c.custom.listNamespacedCustomObject.mockResolvedValue({ items: [{ spec: { scaleTargetRef: { name: 'web' } } }] });
  await expect(applyEnvironmentAutoscaling(env, settings, c)).rejects.toThrow(/managed elsewhere/);
  expect(write).not.toHaveBeenCalled();
});
it('returns a retryable conflict while a previous controller is deleting', async () => {
  const { c, store } = cluster(true);
  store.set('scaledobjects/web-autoscaling', { metadata: { labels: { 'platform.io/autoscaling-environment': env.id } } });
  c.custom.deleteNamespacedCustomObject = jest.fn();
  await expect(applyEnvironmentAutoscaling(env, { ...settings, enabled: false }, c)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('stopping') });
  expect(c.apps.patchNamespacedDeploymentScale).not.toHaveBeenCalled();
});
