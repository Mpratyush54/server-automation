import * as k8s from '@kubernetes/client-node';
import { readFileSync } from 'fs';

export interface NamespaceEnvironment { name: string; namespace: string }
export interface BaselineSettings {
  internetEgress?: boolean;
  internetCidrs?: string[];
  quota?: Record<string, string>;
  databases?: Array<'postgres' | 'mongo' | 'redis'>;
}
const managed = { 'app.kubernetes.io/managed-by': 'platform-namespace-baseline' };
/** Platform/system namespaces that must never be adopted as a project namespace (mirrored in the RBAC admission policy). */
export const reservedNamespaces = ['default', 'platform', 'databases', 'preview', 'ingress-nginx', 'argocd', 'cert-manager', 'monitoring', 'oauth2-proxy', 'portainer', 'storage'];
export const isReservedNamespace = (name: string) => reservedNamespaces.includes(name) || name.startsWith('kube-');
// Public egress must never turn into an allow to another tenant or host network.
export const privateNetworks = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8', '224.0.0.0/4', '240.0.0.0/4'];
const nsPeer = (name: string, labels: Record<string, string>) => ({
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } },
  podSelector: { matchLabels: labels },
});

/** Settings are operator-owned, never taken from an SDK/register payload. */
export function namespaceSettings(projectId: string, environment: string): BaselineSettings {
  const file = process.env.NAMESPACE_BASELINE_SETTINGS_FILE;
  if (!file) return {};
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  return { ...settings.defaults, ...settings.projects?.[projectId]?.[environment] };
}

export function namespaceBaselineManifests(projectId: string, env: NamespaceEnvironment, settings: BaselineSettings = {}, enforce = true) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(projectId) ||
      !/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(env.namespace) ||
      !/^[a-z0-9][a-z0-9-]{0,49}$/.test(env.name) ||
      isReservedNamespace(env.namespace)) {
    throw new Error('Dedicated project namespace and valid project/environment identity required');
  }
  if (settings.internetEgress !== undefined && typeof settings.internetEgress !== 'boolean') throw new Error('internetEgress must be boolean');
  if (settings.databases && (!Array.isArray(settings.databases) || settings.databases.some(type => !['postgres', 'mongo', 'redis'].includes(type)))) throw new Error('Unknown database type');
  const metadata = (name: string) => ({ name, namespace: env.namespace, labels: managed });
  const policy = (name: string, spec: any) => ({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata(name), spec: { podSelector: {}, ...spec } });
  const policies = [
    policy('default-deny-all', { policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] }),
    policy('allow-project', { policyTypes: ['Ingress', 'Egress'], ingress: [{ from: [{ podSelector: {} }] }], egress: [{ to: [{ podSelector: {} }] }] }),
    // Ingress from the controller; egress to it lets apps call public hostnames that hairpin to the controller pod.
    policy('allow-ingress', { policyTypes: ['Ingress', 'Egress'],
      ingress: [{ from: [nsPeer('ingress-nginx', { 'app.kubernetes.io/component': 'controller' })] }],
      egress: [{ to: [nsPeer('ingress-nginx', { 'app.kubernetes.io/component': 'controller' })], ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }] }] }),
    policy('allow-dns', { policyTypes: ['Egress'], egress: [{ to: [nsPeer('kube-system', { 'k8s-app': 'kube-dns' })], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] }] }),
    policy('allow-platform', { policyTypes: ['Egress'], egress: [
      { to: [nsPeer('platform', { app: 'platform-api' })], ports: [{ protocol: 'TCP', port: 3000 }] },
      { to: [nsPeer('monitoring', { 'app.kubernetes.io/name': 'alloy' })], ports: [{ protocol: 'TCP', port: 4317 }, { protocol: 'TCP', port: 4318 }] },
    ] }),
  ];
  const databases = { postgres: { name: 'postgresql', port: 5432 }, mongo: { name: 'mongodb', port: 27017 }, redis: { name: 'redis', port: 6379 } };
  policies.push(policy('allow-databases', { policyTypes: ['Egress'], egress: (settings.databases || ['postgres', 'mongo', 'redis']).map(type => {
    const db = databases[type];
    if (!db) throw new Error('Unknown database type');
    return { to: [nsPeer('databases', { 'app.kubernetes.io/instance': db.name, 'app.kubernetes.io/name': db.name })], ports: [{ protocol: 'TCP', port: db.port }] };
  }) }));
  // Keep an empty policy when disabled: updating settings must revoke old rules.
  const cidrs = settings.internetCidrs || ['0.0.0.0/0'];
  const publicPeers = cidrs.map(cidr => {
    // IPv4 only until explicit dual-stack cluster ranges can be excluded safely.
    const parts = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
    if (!parts || parts.slice(1, 5).some(x => +x > 255) || +parts[5] > 32) throw new Error('Invalid IPv4 egress CIDR');
    const ip = parts.slice(1, 5).reduce((n, x) => (n * 256 + +x) >>> 0, 0);
    const prefix = +parts[5];
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((ip & mask) >>> 0 !== ip) throw new Error('Egress CIDR must use a network address');
    const except = privateNetworks.filter(block => {
      const [address, bits] = block.split('/');
      const blocked = address.split('.').reduce((n, x) => (n * 256 + +x) >>> 0, 0);
      if (+bits <= prefix && ((ip & (0xffffffff << (32 - +bits))) >>> 0) === blocked) throw new Error('Private egress CIDR is forbidden');
      return +bits >= prefix && ((blocked & mask) >>> 0) === ip;
    });
    return { ipBlock: { cidr, ...(except.length ? { except } : {}) } };
  });
  policies.push(policy('allow-internet', { policyTypes: ['Egress'], egress: settings.internetEgress === false || !publicPeers.length ? [] : [{ to: publicPeers, ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }] }] }));
  const production = env.name === 'production';
  const hard = {
    'requests.cpu': production ? '2' : '1', 'requests.memory': production ? '2Gi' : '1Gi',
    'limits.cpu': production ? '4' : '2', 'limits.memory': production ? '4Gi' : '2Gi',
    pods: production ? '20' : '10', persistentvolumeclaims: '4', 'requests.storage': production ? '20Gi' : '5Gi',
    ...settings.quota, 'services.loadbalancers': '0', 'services.nodeports': '0',
  };
  return {
    namespace: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: env.namespace, labels: {
      ...managed, 'platform.io/project': projectId, 'platform.io/env': env.name,
      'pod-security.kubernetes.io/enforce': enforce ? 'restricted' : 'privileged',
      'pod-security.kubernetes.io/warn': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted',
    } } },
    policies,
    quota: { apiVersion: 'v1', kind: 'ResourceQuota', metadata: metadata('project-quota'), spec: { hard } },
    limits: { apiVersion: 'v1', kind: 'LimitRange', metadata: metadata('project-defaults'), spec: { limits: [{ type: 'Container', defaultRequest: { cpu: '100m', memory: '128Mi' }, default: { cpu: '500m', memory: '512Mi' } }] } },
    binding: { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: metadata('platform-namespace-baseline'), roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'platform-namespace-baseline' }, subjects: [{ kind: 'ServiceAccount', name: 'platform-api', namespace: 'platform' }] },
  };
}

export function baselineClients() {
  const kc = new k8s.KubeConfig();
  try { kc.loadFromCluster(); } catch { try { kc.loadFromDefault(); } catch {} }
  return { core: kc.makeApiClient(k8s.CoreV1Api), network: kc.makeApiClient(k8s.NetworkingV1Api), rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api) };
}
const missing = (e: any) => e.code === 404 || e.statusCode === 404 || e.response?.statusCode === 404;
const conflict = (e: any) => e.code === 409 || e.statusCode === 409;

const forbidden = (e: any) => e.code === 403 || e.statusCode === 403 || e.response?.statusCode === 403;
async function withRbacPropagation<T>(fn: () => Promise<T>, delays = [100, 250, 500, 1000, 2000]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (!forbidden(e) || attempt >= delays.length) throw e;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function upsert(api: any, resource: string, body: any) {
  const args = { name: body.metadata.name, namespace: body.metadata.namespace };
  let existing: any;
  try { existing = await api[`read${resource}`](args); } catch (e) { if (!missing(e)) throw e; }
  if (!existing) {
    try { await api[`create${resource}`]({ namespace: args.namespace, body }); return; }
    catch (e) { if (!conflict(e)) throw e; existing = await api[`read${resource}`](args); }
  }
  await api[`replace${resource}`]({ ...args, body: { ...existing, ...body, metadata: { ...existing.metadata, ...body.metadata, resourceVersion: existing.metadata.resourceVersion } } });
}

export async function ensureProjectNamespace(projectId: string, env: NamespaceEnvironment, options: { enforceExisting?: boolean; settings?: BaselineSettings; clients?: ReturnType<typeof baselineClients>; rbacRetryDelaysMs?: number[] } = {}) {
  const settings = options.settings || namespaceSettings(projectId, env.name);
  // Validate before issuing any Kubernetes request.
  const manifest = namespaceBaselineManifests(projectId, env, settings);
  const clients = options.clients || baselineClients();
  let existing: k8s.V1Namespace;
  try { existing = await clients.core.readNamespace({ name: env.namespace }); } catch (e) { if (!missing(e)) throw e; }
  if (existing) {
    const owner = existing.metadata?.labels?.['platform.io/project'];
    if (owner && owner !== projectId) throw new Error('Namespace belongs to another project');
    const enforceKey = 'pod-security.kubernetes.io/enforce';
    if (!options.enforceExisting) manifest.namespace.metadata.labels[enforceKey] = existing.metadata?.labels?.[enforceKey] || 'privileged';
    manifest.namespace.metadata.labels = { ...existing.metadata?.labels, ...manifest.namespace.metadata.labels };
    if (manifest.namespace.metadata.labels[enforceKey] !== 'restricted') console.warn(`[namespace-baseline] ${env.namespace}: PSA restricted warn/audit only; review pod admission warnings before enforcing`);
  }
  await upsert(clients.core, 'Namespace', manifest.namespace);
  await upsert(clients.rbac, 'NamespacedRoleBinding', manifest.binding);
  // A just-created RoleBinding reaches the RBAC authorizer cache asynchronously,
  // so the first baseline write may briefly be forbidden; retry only that case.
  await withRbacPropagation(() => upsert(clients.network, 'NamespacedNetworkPolicy', manifest.policies[1]), options.rbacRetryDelaysMs);
  // Allows first, deny last: reruns do not temporarily cut existing connections.
  for (const policy of [...manifest.policies.slice(2), manifest.policies[0]]) await upsert(clients.network, 'NamespacedNetworkPolicy', policy);
  await upsert(clients.core, 'NamespacedLimitRange', manifest.limits);
  await upsert(clients.core, 'NamespacedResourceQuota', manifest.quota);
  return manifest;
}

// API defaulting can omit empty lists and object key ordering is not significant.
export function canonicalBaseline(value: any): string {
  const normalize = (v: any): any => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined && !(Array.isArray(v[k]) && !v[k].length)).map(k => [k, normalize(v[k])])) : v;
  return JSON.stringify(normalize(value));
}

export async function namespaceBaselineStatus(projectId: string, env: NamespaceEnvironment, clients?: ReturnType<typeof baselineClients>, timeoutMs = 3000) {
  if (isReservedNamespace(env.namespace)) return { namespace: env.namespace, policyApplied: false, error: 'Shared legacy namespace; redeploy to migrate to a dedicated namespace' };
  let timer: NodeJS.Timeout | undefined;
  // Project detail must stay responsive when the cluster is slow or unreachable.
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
  try { return await Promise.race([readBaselineStatus(projectId, env, clients), timeout]); }
  catch { return { namespace: env.namespace, policyApplied: false, error: 'Baseline status unavailable' }; }
  finally { clearTimeout(timer); }
}

async function readBaselineStatus(projectId: string, env: NamespaceEnvironment, clients?: ReturnType<typeof baselineClients>) {
  try {
    const { core, network } = clients || baselineClients();
    const [ns, policies, quota, limits] = await Promise.all([
      core.readNamespace({ name: env.namespace }), network.listNamespacedNetworkPolicy({ namespace: env.namespace }),
      core.readNamespacedResourceQuota({ namespace: env.namespace, name: 'project-quota' }),
      core.readNamespacedLimitRange({ namespace: env.namespace, name: 'project-defaults' }),
    ]);
    const expected = namespaceBaselineManifests(projectId, env, namespaceSettings(projectId, env.name));
    const additionalPolicies = policies.items.filter(p => !expected.policies.some(e => e.metadata.name === p.metadata?.name)).map(p => p.metadata?.name);
    const policyApplied = !additionalPolicies.length && expected.policies.every(p => policies.items.some(actual => actual.metadata?.name === p.metadata.name && canonicalBaseline(actual.spec) === canonicalBaseline(p.spec)));
    return { namespace: env.namespace, policyApplied, additionalPolicies, ownerMatches: ns.metadata?.labels?.['platform.io/project'] === projectId,
      psa: ns.metadata?.labels?.['pod-security.kubernetes.io/enforce'], quota: { hard: quota.status?.hard || quota.spec?.hard, used: quota.status?.used || {} }, quotaApplied: canonicalBaseline(quota.spec) === canonicalBaseline(expected.quota.spec), limitsApplied: canonicalBaseline(limits.spec) === canonicalBaseline(expected.limits.spec) };
  } catch (e: any) { return { namespace: env.namespace, policyApplied: false, error: e.code === 404 ? 'Baseline not applied' : 'Baseline status unavailable' }; }
}
