import * as k8s from '@kubernetes/client-node';
import { loadKubeConfig } from './kube-config';
import { Environment } from '../entities/Environment';
import { isReservedNamespace } from './namespace-baseline';
import { AutoscalingError, AutoscalingSettings, autoscalingNamespace, currentScalingUsage, defaultAutoscaling, renderHpa, renderHttpScaledObject, renderScaledObject, scalingName, validateScalingQuota } from './autoscaling';

const body = (r: any) => r.body || r;
const missing = (e: any) => (e.code || e.statusCode || e.response?.statusCode) === 404;
const ignoreMissing = (e: any) => { if (!missing(e)) throw e; };
export function autoscalingClients() {
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  return { core: kc.makeApiClient(k8s.CoreV1Api), apps: kc.makeApiClient(k8s.AppsV1Api),
    hpa: kc.makeApiClient(k8s.AutoscalingV2Api), custom: kc.makeApiClient(k8s.CustomObjectsApi),
    extensions: kc.makeApiClient(k8s.ApiextensionsV1Api), network: kc.makeApiClient(k8s.NetworkingV1Api) };
}
type Clients = ReturnType<typeof autoscalingClients>;

export async function scalingCapabilities(c: Clients) {
  const exists = async (name: string) => {
    try { await c.extensions.readCustomResourceDefinition({ name }); return true; }
    catch (e) { if (missing(e)) return false; throw e; }
  };
  return { rps: await exists('scaledobjects.keda.sh'), scaleToZero: await exists('httpscaledobjects.http.keda.sh') };
}

async function workloads(env: Environment, c: Clients) {
  if (isReservedNamespace(env.namespace)) throw new AutoscalingError('Dedicated project namespace required', 409);
  const ns = body(await c.core.readNamespace({ name: env.namespace }));
  if (ns.metadata?.labels?.['platform.io/project'] !== env.projectId || ns.metadata?.labels?.['platform.io/env'] !== env.name) throw new AutoscalingError('Namespace ownership could not be verified', 409);
  const items = body(await c.apps.listNamespacedDeployment({ namespace: env.namespace })).items || [];
  if (env.name === 'preview' && items.some((d: any) => d.metadata?.labels?.['platform-project-id'] !== env.projectId)) throw new AutoscalingError('Preview ownership could not be verified', 409);
  return items;
}

const customArgs = (namespace: string, name: string, http = false) => ({ namespace, name,
  group: http ? 'http.keda.sh' : 'keda.sh', version: 'v1alpha1', plural: http ? 'httpscaledobjects' : 'scaledobjects' });
const managed = (obj: any, env: Environment) => obj.metadata?.labels?.['platform.io/autoscaling-environment'] === env.id;

async function upsert(read: () => Promise<any>, create: (obj: any) => Promise<any>, replace: (obj: any) => Promise<any>, obj: any, env: Environment) {
  let existing: any;
  try { existing = body(await read()); } catch (e) { if (!missing(e)) throw e; }
  if (!existing) return create(obj);
  if (!managed(existing, env)) throw new AutoscalingError('A scaling resource with this name is already managed elsewhere', 409);
  obj.metadata.resourceVersion = existing.metadata.resourceVersion;
  return replace(obj);
}

async function remove(c: Clients, env: Environment, name: string, kind: 'hpa' | 'keda' | 'http') {
  const args = customArgs(env.namespace, name, kind === 'http');
  try {
    const obj = body(kind === 'hpa' ? await c.hpa.readNamespacedHorizontalPodAutoscaler({ namespace: env.namespace, name }) : await c.custom.getNamespacedCustomObject(args));
    if (!managed(obj, env)) return;
    if (kind === 'hpa' && obj.metadata.ownerReferences?.some((r: any) => r.kind === 'ScaledObject')) return;
    if (kind === 'hpa') await c.hpa.deleteNamespacedHorizontalPodAutoscaler({ namespace: env.namespace, name });
    else await c.custom.deleteNamespacedCustomObject({ ...args, propagationPolicy: 'Foreground' });
    try {
      if (kind === 'hpa') await c.hpa.readNamespacedHorizontalPodAutoscaler({ namespace: env.namespace, name });
      else await c.custom.getNamespacedCustomObject(args);
      throw new AutoscalingError('Previous scaling controller is stopping; retry shortly', 409);
    } catch (e) { ignoreMissing(e); }
  } catch (e) { ignoreMissing(e); }
}

/** Argo must leave the replica count to the autoscaler. Preview workloads have no Argo app. */
async function ignoreArgoReplicas(env: Environment, c: Clients) {
  if (env.name === 'preview') return;
  const args = { group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications', name: env.namespace };
  const app = body(await c.custom.getNamespacedCustomObject(args));
  const rule = { group: 'apps', kind: 'Deployment', namespace: env.namespace, jsonPointers: ['/spec/replicas'] };
  app.spec.ignoreDifferences = [...(app.spec.ignoreDifferences || []).filter((r: any) => !(r.group === rule.group && r.kind === rule.kind && r.namespace === rule.namespace && r.jsonPointers?.includes('/spec/replicas'))), rule];
  app.spec.syncPolicy ||= {};
  app.spec.syncPolicy.syncOptions = [...new Set([...(app.spec.syncPolicy.syncOptions || []), 'RespectIgnoreDifferences=true'])];
  await c.custom.replaceNamespacedCustomObject({ ...args, body: app });
}

// A same-namespace ExternalName service keeps the original ingress host/TLS and request metrics.
async function routePreview(c: Clients, env: Environment, deployment: any, enabled: boolean) {
  const namespace = env.namespace;
  const name = deployment.metadata.name;
  const alias = scalingName(name);
  const ingresses = body(await c.network.listNamespacedIngress({ namespace })).items || [];
  if (enabled) {
    const service: any = { apiVersion: 'v1', kind: 'Service', metadata: { name: alias, namespace,
      labels: { 'platform.io/autoscaling-environment': env.id }, ownerReferences: [{ apiVersion: 'apps/v1', kind: 'Deployment', name, uid: deployment.metadata.uid }] },
    spec: { type: 'ExternalName', externalName: 'keda-add-ons-http-interceptor-proxy.keda.svc.cluster.local', ports: [{ port: 8080 }] } };
    await upsert(() => c.core.readNamespacedService({ namespace, name: alias }), obj => c.core.createNamespacedService({ namespace, body: obj }), obj => c.core.replaceNamespacedService({ namespace, name: alias, body: obj }), service, env);
  }
  for (const ingress of ingresses) {
    let changed = false;
    for (const rule of ingress.spec?.rules || []) for (const path of rule.http?.paths || []) {
      if (enabled && path.backend?.service?.name === name) {
        ingress.metadata.annotations ||= {};
        ingress.metadata.annotations['platform.io/autoscaling-backend'] = JSON.stringify({ name, port: path.backend.service.port });
        ingress.metadata.annotations['nginx.ingress.kubernetes.io/proxy-read-timeout'] = '90';
        path.backend.service = { name: alias, port: { number: 8080 } };
        changed = true;
      } else if (!enabled && path.backend?.service?.name === alias) {
        const original = JSON.parse(ingress.metadata.annotations?.['platform.io/autoscaling-backend'] || 'null');
        if (!original || original.name !== name) throw new AutoscalingError('Preview ingress backend needs administrator recovery', 409);
        path.backend.service = original;
        changed = true;
      }
    }
    if (changed) await c.network.replaceNamespacedIngress({ namespace, name: ingress.metadata.name, body: ingress });
  }
  if (!enabled) {
    try {
      const service = body(await c.core.readNamespacedService({ namespace, name: alias }));
      if (managed(service, env)) await c.core.deleteNamespacedService({ namespace, name: alias });
    } catch (e) { ignoreMissing(e); }
  }
}

export async function readEnvironmentAutoscaling(env: Environment, c = autoscalingClients()) {
  env = { ...env, namespace: autoscalingNamespace(env) };
  const deployments = await workloads(env, c);
  const capabilities = await scalingCapabilities(c);
  const hpas = body(await c.hpa.listNamespacedHorizontalPodAutoscaler({ namespace: env.namespace })).items || [];
  return { namespace: env.namespace, settings: env.autoscaling || defaultAutoscaling, capabilities,
    workloads: deployments.map((d: any) => ({ name: d.metadata.name, currentReplicas: d.status?.replicas ?? 0,
      readyReplicas: d.status?.readyReplicas ?? 0,
      hpa: hpas.find((h: any) => h.spec?.scaleTargetRef?.name === d.metadata.name)?.status || null })),
  };
}

export async function applyEnvironmentAutoscaling(env: Environment, settings: AutoscalingSettings, c = autoscalingClients()) {
  env = { ...env, namespace: autoscalingNamespace(env) };
  const namespace = env.namespace;
  const deployments = await workloads(env, c);
  if (settings.enabled && !deployments.length) throw new AutoscalingError('Deploy the environment before enabling autoscaling', 409);
  const capabilities = await scalingCapabilities(c);
  const zero = settings.enabled && settings.minReplicas === 0;
  const keda = settings.enabled && (zero || settings.targetRps != null);
  if (keda && (!capabilities.rps || (zero && !capabilities.scaleToZero))) throw new AutoscalingError('RPS and preview scale-to-zero need the full profile with INSTALL_KEDA=true (KEDA and HTTP add-on)', 409);
  if (settings.enabled) {
    const quotas = body(await c.core.listNamespacedResourceQuota({ namespace })).items || [];
    const pods = body(await c.core.listNamespacedPod({ namespace })).items || [];
    validateScalingQuota(settings, deployments, quotas, currentScalingUsage(deployments, pods));
    const hpas = body(await c.hpa.listNamespacedHorizontalPodAutoscaler({ namespace })).items || [];
    const scaledObjects = capabilities.rps ? body(await c.custom.listNamespacedCustomObject({ group: 'keda.sh', version: 'v1alpha1', namespace, plural: 'scaledobjects' })).items || [] : [];
    for (const d of deployments) {
      if (scaledObjects.some((s: any) => s.spec?.scaleTargetRef?.name === d.metadata.name && !managed(s, env))) throw new AutoscalingError('Deployment already has an autoscaler managed elsewhere', 409);
      for (const h of hpas.filter((h: any) => h.spec?.scaleTargetRef?.name === d.metadata.name && !managed(h, env))) {
        const owner = h.metadata.ownerReferences?.find((r: any) => r.kind === 'ScaledObject' && r.name === scalingName(d.metadata.name));
        const parent = owner && capabilities.rps ? body(await c.custom.getNamespacedCustomObject(customArgs(namespace, owner.name))) : null;
        if (!parent || !managed(parent, env) || parent.metadata.uid !== owner.uid) throw new AutoscalingError('Deployment already has an autoscaler managed elsewhere', 409);
      }
    }
  }
  // Preflight every HTTP route before changing any controllers.
  const routes: Record<string, { host: string; port: number | string; service: string }> = {};
  if (zero || settings.enabled && settings.targetRps != null) {
    const services = body(await c.core.listNamespacedService({ namespace })).items || [];
    const ingresses = body(await c.network.listNamespacedIngress({ namespace })).items || [];
    for (const d of deployments) {
      const name = d.metadata.name;
      const rules = ingresses.flatMap((i: any) => i.spec?.rules || []);
      const service = services.find((s: any) => (!zero || s.metadata.name === name) && Object.entries(s.spec?.selector || {}).length &&
        Object.entries(s.spec.selector).every(([k, v]) => d.spec.template.metadata?.labels?.[k] === v) &&
        rules.some((r: any) => r.host && r.http?.paths?.some((p: any) => [s.metadata.name, scalingName(name)].includes(p.backend?.service?.name))));
      const rule = service && rules.find((r: any) => r.host && r.http?.paths?.some((p: any) => [service.metadata.name, scalingName(name)].includes(p.backend?.service?.name)));
      if (!service || !rule) throw new AutoscalingError('Request scaling needs an ingress and a Service selecting each Deployment; preview activation needs the Cairn preview Service', 409);
      routes[name] = { host: rule.host, port: service.spec.ports[0].name || service.spec.ports[0].port, service: service.metadata.name };
    }
  }
  if (settings.enabled) await ignoreArgoReplicas(env, c);
  for (const d of deployments) {
    const name = d.metadata.name;
    const scaler = scalingName(name);
    const decorate = (obj: any) => {
      obj.metadata.labels = { 'platform.io/autoscaling-environment': env.id };
      obj.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'Deployment', name, uid: d.metadata.uid }];
      return obj;
    };
    if (!keda) {
      if (capabilities.scaleToZero) await remove(c, env, scaler, 'http');
      if (capabilities.rps) await remove(c, env, scaler, 'keda');
    }
    if (!zero && env.name === 'preview') {
      // Wake before returning ingress traffic directly to the backing Service.
      if ((d.spec.replicas ?? 1) === 0) await c.apps.patchNamespacedDeploymentScale({ namespace, name, body: { spec: { replicas: Math.max(1, settings.minReplicas) } } });
      await routePreview(c, env, d, false);
    }
    if (!settings.enabled) { await remove(c, env, scaler, 'hpa'); continue; }
    if (keda) {
      await remove(c, env, scaler, 'hpa');
      if (zero) {
        const route = routes[name];
        const obj = decorate(renderHttpScaledObject(namespace, name, route.host, route.port, settings));
        const args = customArgs(namespace, scaler, true);
        await upsert(() => c.custom.getNamespacedCustomObject(args), b => c.custom.createNamespacedCustomObject({ ...args, body: b }), b => c.custom.replaceNamespacedCustomObject({ ...args, body: b }), obj, env);
        await routePreview(c, env, d, true);
      } else if (capabilities.scaleToZero) await remove(c, env, scaler, 'http');
      const args = customArgs(namespace, scaler);
      await upsert(() => c.custom.getNamespacedCustomObject(args), b => c.custom.createNamespacedCustomObject({ ...args, body: b }), b => c.custom.replaceNamespacedCustomObject({ ...args, body: b }), decorate(renderScaledObject(namespace, name, settings, routes[name]?.service)), env);
    } else {
      try {
        const existing = body(await c.hpa.readNamespacedHorizontalPodAutoscaler({ namespace, name: scaler }));
        if (existing.metadata.ownerReferences?.some((r: any) => r.kind === 'ScaledObject')) throw new AutoscalingError('Previous scaling controller is stopping; retry shortly', 409);
      } catch (e) { ignoreMissing(e); }
      await upsert(() => c.hpa.readNamespacedHorizontalPodAutoscaler({ namespace, name: scaler }), b => c.hpa.createNamespacedHorizontalPodAutoscaler({ namespace, body: b }), b => c.hpa.replaceNamespacedHorizontalPodAutoscaler({ namespace, name: scaler, body: b }), decorate(renderHpa(namespace, name, settings)), env);
    }
  }
}
