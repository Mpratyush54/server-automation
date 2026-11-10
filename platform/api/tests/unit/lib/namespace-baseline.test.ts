import { tmpdir } from 'os';
jest.mock('@kubernetes/client-node', () => ({}));
import { namespaceBaselineManifests, ensureProjectNamespace, privateNetworks, canonicalBaseline, namespaceBaselineStatus, namespaceSettings, reservedNamespaces } from '../../../src/lib/namespace-baseline';
import { podSecurityWarnings, reportNamespaceBaseline, backfillFingerprint, validateBackfillReport } from '../../../src/lib/namespace-backfill';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { parseAllDocuments } from 'yaml';

const env = { name: 'production', namespace: 'project-production-abcd' };
const manifests = (settings = {}) => namespaceBaselineManifests('project-a', env, settings);
const policy = (name: string, settings = {}) => manifests(settings).policies.find(p => p.metadata.name === name)!;
function clients(existing?: any) {
  const store = new Map<string, any>();
  const calls: string[] = [];
  if (existing) store.set(`Namespace/${env.namespace}`, existing);
  const api: any = {};
  for (const resource of ['Namespace', 'NamespacedRoleBinding', 'NamespacedNetworkPolicy', 'NamespacedLimitRange', 'NamespacedResourceQuota']) {
    api[`read${resource}`] = jest.fn(async ({ name }: any) => {
      if (!store.has(`${resource}/${name}`)) throw { code: 404 };
      return store.get(`${resource}/${name}`);
    });
    for (const verb of ['create', 'replace']) api[`${verb}${resource}`] = jest.fn(async ({ body }: any) => {
      calls.push(`${verb}${resource}/${body.metadata.name}`);
      store.set(`${resource}/${body.metadata.name}`, { ...body, metadata: { ...body.metadata, resourceVersion: '7' } });
    });
  }
  api.listNamespacedPod = jest.fn(async () => ({ items: [] }));
  api.listNamespacedNetworkPolicy = jest.fn(async () => ({ items: [] }));
  api.listNamespacedResourceQuota = jest.fn(async () => ({ items: [] }));
  return { core: api, network: api, rbac: api, store, calls };
}
it('labels new namespaces restricted in all three PSA modes', () => {
  expect(manifests().namespace.metadata.labels).toMatchObject({ 'platform.io/project': 'project-a', 'platform.io/env': 'production',
    'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted' });
});
it('denies both directions and combines namespace AND pod selectors for narrow allows', () => {
  expect(policy('default-deny-all').spec).toMatchObject({ policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] });
  expect(policy('allow-ingress').spec.ingress[0].from[0]).toEqual({ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' } }, podSelector: { matchLabels: { 'app.kubernetes.io/component': 'controller' } } });
  expect(policy('allow-dns').spec.egress[0]).toMatchObject({ to: [{ podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] });
});
it('allows selected shared database services only on database ports', () => {
  const rules = policy('allow-databases', { databases: ['postgres'] }).spec.egress;
  expect(rules).toHaveLength(1);
  expect(rules[0]).toMatchObject({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'databases' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'postgresql' } } }], ports: [{ protocol: 'TCP', port: 5432 }] });
  expect(policy('allow-databases', { databases: [] }).spec.egress).toEqual([]);
});
it('excludes private destinations from public HTTP/HTTPS and revokes internet egress', () => {
  expect(policy('allow-internet').spec.egress[0].to[0].ipBlock.except).toEqual(privateNetworks);
  expect(policy('allow-internet').spec.egress[0].ports).toEqual([{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }]);
  expect(policy('allow-internet', { internetEgress: false }).spec.egress).toEqual([]);
  expect(policy('allow-internet', { internetCidrs: [] }).spec.egress).toEqual([]);
  expect(policy('allow-internet', { internetCidrs: ['8.8.8.0/24'] }).spec.egress[0].to).toEqual([{ ipBlock: { cidr: '8.8.8.0/24' } }]);
  for (const cidr of ['10.0.0.0/8', '192.168.1.0/24', '::/0', '8.8.8.1/24', '300.0.0.0/8']) expect(() => manifests({ internetCidrs: [cidr] })).toThrow();
});
it('has conservative environment quotas, operator overrides, fixed service restrictions and defaults', () => {
  expect(manifests({ quota: { pods: '30', 'services.loadbalancers': '4' } }).quota.spec.hard).toMatchObject({ pods: '30', 'services.loadbalancers': '0', 'services.nodeports': '0', 'requests.cpu': '2', 'requests.memory': '2Gi', 'requests.storage': '20Gi', persistentvolumeclaims: '4' });
  expect(namespaceBaselineManifests('project-a', { ...env, name: 'preview' }).quota.spec.hard.pods).toBe('10');
  expect(manifests().limits.spec.limits[0]).toMatchObject({ type: 'Container', defaultRequest: { cpu: '100m', memory: '128Mi' }, default: { cpu: '500m', memory: '512Mi' } });
});
it('refuses shared/system namespaces before any API write', async () => {
  const c = clients();
  for (const namespace of ['default', 'preview', 'platform', 'databases', 'kube-system', 'monitoring', 'cert-manager', 'storage', '../other']) await expect(ensureProjectNamespace('project-a', { ...env, namespace }, { clients: c })).rejects.toThrow();
  expect(c.calls).toEqual([]);
});
it('creates the baseline idempotently with resource versions and allows before deny', async () => {
  const c = clients();
  await ensureProjectNamespace('project-a', env, { clients: c });
  expect(c.calls.indexOf('createNamespacedNetworkPolicy/allow-dns')).toBeLessThan(c.calls.indexOf('createNamespacedNetworkPolicy/default-deny-all'));
  await ensureProjectNamespace('project-a', env, { clients: c });
  expect(c.core.replaceNamespacedResourceQuota).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ metadata: expect.objectContaining({ resourceVersion: '7' }) }) }));
  expect(c.core.replaceNamespace.mock.calls[0][0].body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
});
it('backfills existing namespaces in warn mode, preserves labels, and requires explicit enforcement', async () => {
  const c = clients({ metadata: { name: env.namespace, resourceVersion: '1', labels: { custom: 'preserved' } } });
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  await ensureProjectNamespace('project-a', env, { clients: c });
  expect(c.core.replaceNamespace.mock.calls[0][0].body.metadata.labels).toMatchObject({ custom: 'preserved', 'pod-security.kubernetes.io/enforce': 'privileged', 'pod-security.kubernetes.io/warn': 'restricted' });
  await ensureProjectNamespace('project-a', env, { clients: c, enforceExisting: true });
  expect(c.core.replaceNamespace.mock.calls[1][0].body.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
  warn.mockRestore();
});
it('does not swallow authorization errors or claim foreign namespaces', async () => {
  const c = clients({ metadata: { labels: { 'platform.io/project': 'another-project' } } });
  await expect(ensureProjectNamespace('project-a', env, { clients: c })).rejects.toThrow(/another/);
  expect(c.calls).toEqual([]);
  c.core.readNamespace.mockRejectedValue({ code: 403 });
  await expect(ensureProjectNamespace('project-a', env, { clients: c })).rejects.toEqual({ code: 403 });
});
it('dry-run inventories workloads, policies and usage without mutations', async () => {
  const c = clients({ metadata: { labels: {} } });
  c.core.listNamespacedPod.mockResolvedValue({ items: [{ metadata: { name: 'legacy' }, spec: { hostNetwork: true, containers: [{ name: 'app', securityContext: { privileged: true } }] } }] });
  const report = await reportNamespaceBaseline('project-a', env, c);
  expect(report.warnings[0].warnings).toContain('app: privileged');
  expect(c.calls).toEqual([]);
  expect(podSecurityWarnings({ spec: { containers: [{ name: 'app', securityContext: { runAsNonRoot: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } }, resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } } }] } })).toEqual([]);
});
it('compares Kubernetes manifests independent of key order and omitted empty lists', () => {
  expect(canonicalBaseline({ b: 1, a: { ingress: [], x: 3 } })).toBe(canonicalBaseline({ a: { x: 3 }, b: 1 }));
});
it('has no raw namespace creation or Argo auto-create bypass outside the baseline', () => {
  const src = join(__dirname, '../../../src');
  const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  for (const file of scan(src).filter(f => !f.endsWith('namespace-baseline.ts'))) {
    expect(readFileSync(file, 'utf8')).not.toMatch(/\.createNamespace\s*\(|CreateNamespace=true/);
  }
});
it('grants baseline resources through namespace bindings, with admission guarding bootstrap', () => {
  const docs = parseAllDocuments(readFileSync(join(__dirname, '../../../../../platformctl/internal/manifests/data/platform-api-rbac.yaml'), 'utf8')).map(d => d.toJS());
  expect(docs.filter(d => d.kind === 'ClusterRoleBinding').every(d => d.roleRef.name !== 'platform-namespace-baseline')).toBe(true);
  expect(docs.find(d => d.kind === 'ClusterRole' && d.metadata.name === 'platform-api').rules.flatMap((r: any) => r.resources)).not.toContain('networkpolicies');
  const guard = docs.find(d => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name === 'platform-baseline-bindings');
  expect(guard.spec.failurePolicy).toBe('Fail');
  expect(guard.spec.validations[0].expression).toContain('platform.io/project');
  expect(guard.spec.validations[1].expression).toContain('object.roleRef.name');
  const nsGuard = docs.find(d => d.kind === 'ValidatingAdmissionPolicy' && d.metadata.name === 'platform-project-namespaces');
  expect(nsGuard.spec.failurePolicy).toBe('Fail');
  expect(nsGuard.spec.matchConstraints.resourceRules[0].resources).toEqual(['namespaces']);
  expect(nsGuard.spec.validations.map((v: any) => v.expression).join(' ')).toContain("oldObject.metadata.labels['platform.io/project']");
  for (const name of ['platform-baseline-bindings', 'platform-project-namespaces']) {
    expect(docs.find(d => d.kind === 'ValidatingAdmissionPolicyBinding' && d.metadata.name === name).spec.validationActions).toEqual(['Deny']);
  }
  // Admission reserved lists mirror the API's reservedNamespaces.
  const reservedLiteral = `[${reservedNamespaces.map(n => `'${n}'`).join(', ')}]`;
  expect(guard.spec.validations[0].expression).toContain(reservedLiteral);
  expect(nsGuard.spec.validations[0].expression).toContain(reservedLiteral);
});

it('requires a reviewed dry-run, rejects changed settings/policies and blocks unsafe enforcement', () => {
  const rows = [{ projectId: 'a', namespace: 'ns-a', desired: manifests(), existingPolicies: [], warnings: [] }];
  const reviewed = { fingerprint: backfillFingerprint(rows) };
  expect(() => validateBackfillReport(rows, reviewed, true)).not.toThrow();
  const changed = [{ ...rows[0], existingPolicies: ['allow-all'] }];
  expect(() => validateBackfillReport(changed, reviewed, false)).toThrow(/configuration changed/);
  expect(() => validateBackfillReport([{ ...rows[0], warnings: ['privileged'] }], reviewed, true)).toThrow(/warnings/);
  expect(() => validateBackfillReport([{ ...rows[0], warnings: ['privileged'] }], reviewed, false)).not.toThrow();
  expect(backfillFingerprint([rows[0], { projectId: 'b', namespace: 'ns-b' }])).toBe(backfillFingerprint([{ projectId: 'b', namespace: 'ns-b' }, rows[0]]));
});
it('handles concurrent creation without masking non-conflict failures', async () => {
  const c = clients();
  c.core.createNamespace.mockImplementationOnce(async ({ body }: any) => {
    c.store.set(`Namespace/${body.metadata.name}`, { ...body, metadata: { ...body.metadata, resourceVersion: '2' } });
    throw { code: 409 };
  });
  await ensureProjectNamespace('project-a', env, { clients: c });
  expect(c.core.replaceNamespace).toHaveBeenCalled();
  const offline = clients();
  offline.network.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 503 });
  await expect(ensureProjectNamespace('project-a', env, { clients: offline })).rejects.toEqual({ code: 503 });
  expect(offline.core.createNamespacedResourceQuota).not.toHaveBeenCalled();
});

it('reports matching manifests, quota usage and policy drift', async () => {
  const c = clients();
  await ensureProjectNamespace('project-a', env, { clients: c });
  c.network.listNamespacedNetworkPolicy.mockResolvedValue({ items: manifests().policies });
  c.store.get('NamespacedResourceQuota/project-quota').status = { used: { pods: '2' } };
  expect(await namespaceBaselineStatus('project-a', env, c)).toMatchObject({ policyApplied: true, ownerMatches: true, psa: 'restricted', quotaApplied: true, limitsApplied: true, quota: { used: { pods: '2' } } });
  c.network.listNamespacedNetworkPolicy.mockResolvedValue({ items: [...manifests().policies, { metadata: { name: 'allow-all' } }] });
  expect(await namespaceBaselineStatus('project-a', env, c)).toMatchObject({ policyApplied: false, additionalPolicies: ['allow-all'] });
  c.core.readNamespace.mockRejectedValue({ code: 403 });
  expect(await namespaceBaselineStatus('project-a', env, c)).toMatchObject({ policyApplied: false, error: 'Baseline status unavailable' });
});
it('loads operator settings from a temp file with environment overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'namespace-settings-'));
  const previous = process.env.NAMESPACE_BASELINE_SETTINGS_FILE;
  try {
    const file = join(root, 'settings.json');
    writeFileSync(file, JSON.stringify({ defaults: { internetEgress: true }, projects: { 'project-a': { production: { internetEgress: false, quota: { pods: '3' } } } } }));
    process.env.NAMESPACE_BASELINE_SETTINGS_FILE = file;
    expect(namespaceSettings('project-a', 'production')).toEqual({ internetEgress: false, quota: { pods: '3' } });
    expect(namespaceSettings('project-b', 'production')).toEqual({ internetEgress: true });
    writeFileSync(file, 'invalid');
    expect(() => namespaceSettings('project-a', 'production')).toThrow();
  } finally {
    if (previous === undefined) delete process.env.NAMESPACE_BASELINE_SETTINGS_FILE;
    else process.env.NAMESPACE_BASELINE_SETTINGS_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

it('grants exactly the verbs the baseline uses, namespaced only, with no broad RBAC', () => {
  const rbacPath = join(__dirname, '../../../../../platformctl/internal/manifests/data/platform-api-rbac.yaml');
  const docs = parseAllDocuments(readFileSync(rbacPath, 'utf8')).map(d => d.toJS());
  const baseline = docs.find(d => d.kind === 'ClusterRole' && d.metadata.name === 'platform-namespace-baseline');
  expect(baseline.rules).toEqual([
    { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['get', 'list', 'create', 'update'] },
    { apiGroups: [''], resources: ['resourcequotas', 'limitranges'], verbs: ['get', 'list', 'create', 'update'] },
    // #31 live topology: read-only lists in project namespaces; never secrets/configmaps.
    { apiGroups: [''], resources: ['pods', 'services', 'persistentvolumeclaims', 'events'], verbs: ['list'] },
    { apiGroups: ['apps'], resources: ['deployments', 'replicasets'], verbs: ['list'] },
    { apiGroups: ['networking.k8s.io'], resources: ['ingresses'], verbs: ['list'] },
    { apiGroups: ['cert-manager.io'], resources: ['certificates'], verbs: ['list'] },
  ]);
  expect(baseline.rules.flatMap((r: any) => r.resources)).not.toContain('secrets');
  const api = docs.find(d => d.kind === 'ClusterRole' && d.metadata.name === 'platform-api');
  const rule = (resource: string) => api.rules.find((r: any) => r.resources.includes(resource));
  expect(rule('namespaces').verbs).toEqual(['get', 'list', 'create', 'update']);
  expect(rule('rolebindings').verbs).toEqual(['get', 'create', 'update']);
  expect(rule('clusterroles')).toEqual({ apiGroups: ['rbac.authorization.k8s.io'], resources: ['clusterroles'], resourceNames: ['platform-namespace-baseline'], verbs: ['bind'] });
  const all = docs.filter(d => d && /Role$/.test(d.kind)).flatMap(d => d.rules);
  const verbs = all.flatMap((r: any) => r.verbs);
  expect(verbs).not.toContain('escalate');
  expect(verbs).not.toContain('*');
  expect(all.flatMap((r: any) => r.resources)).not.toContain('clusterrolebindings');
  // The GitOps copy must stay identical to the installer copy.
  const gitops = readFileSync(join(__dirname, '../../../../../k8s/platform/api-rbac.yaml'), 'utf8').replace(/\r\n/g, '\n');
  expect(gitops).toBe(readFileSync(rbacPath, 'utf8').replace(/\r\n/g, '\n'));
});
it('keeps ingress-nginx reachable both ways and DNS/databases/platform egress narrow', () => {
  const ingress = policy('allow-ingress').spec;
  const controller = { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' } }, podSelector: { matchLabels: { 'app.kubernetes.io/component': 'controller' } } };
  expect(ingress.policyTypes).toEqual(['Ingress', 'Egress']);
  expect(ingress.ingress).toEqual([{ from: [controller] }]);
  expect(ingress.egress).toEqual([{ to: [controller], ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }] }]);
  expect(policy('allow-dns').spec.egress[0].to[0].namespaceSelector).toEqual({ matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } });
  expect(policy('allow-databases').spec.egress.map((r: any) => r.ports[0].port)).toEqual([5432, 27017, 6379]);
  expect(policy('allow-platform').spec.egress[0]).toEqual({ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'platform' } }, podSelector: { matchLabels: { app: 'platform-api' } } }], ports: [{ protocol: 'TCP', port: 3000 }] });
  // No allow rule selects other project namespaces.
  expect(JSON.stringify(manifests().policies)).not.toContain('platform.io/project');
});
it('retries baseline writes while a new RoleBinding propagates, but not other failures', async () => {
  const c = clients();
  c.network.createNamespacedNetworkPolicy.mockRejectedValueOnce({ code: 403 }).mockRejectedValueOnce({ statusCode: 403 });
  await ensureProjectNamespace('project-a', env, { clients: c, rbacRetryDelaysMs: [1, 1, 1] });
  expect(c.calls).toContain('createNamespacedNetworkPolicy/allow-project');
  expect(c.calls).toContain('createNamespacedResourceQuota/project-quota');
  const denied = clients();
  denied.network.createNamespacedNetworkPolicy.mockRejectedValue({ code: 403 });
  await expect(ensureProjectNamespace('project-a', env, { clients: denied, rbacRetryDelaysMs: [1, 1] })).rejects.toEqual({ code: 403 });
  expect(denied.network.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(3);
  expect(denied.core.createNamespacedResourceQuota).not.toHaveBeenCalled();
});
it('status stays responsive and explains legacy shared namespaces', async () => {
  const c = clients();
  for (const fn of ['readNamespace', 'listNamespacedNetworkPolicy', 'readNamespacedResourceQuota', 'readNamespacedLimitRange']) c.core[fn].mockImplementation(() => new Promise(() => {}));
  await expect(namespaceBaselineStatus('project-a', env, c, 5)).resolves.toMatchObject({ policyApplied: false, error: 'Baseline status unavailable' });
  await expect(namespaceBaselineStatus('project-a', { name: 'preview', namespace: 'preview' }, c)).resolves.toMatchObject({ error: expect.stringMatching(/legacy/i) });
});

// @kubernetes/client-node serializes LimitRangeItem.default from `_default` and
// NetworkPolicyIngressRule.from from `_from`; a plain key is silently dropped.
// (The client's serializer is ESM-only, so its contract is restated here; the
// VM e2e scripts/test-namespace-isolation.mjs exercises the real wire format.)
it('sends LimitRange defaults and ingress peers under the typed client property names', async () => {
  // Regression: plain keys were dropped on the wire, so LimitRanges had no
  // default limits (quota rejected every pod) and allow-* ingress allowed all.
  const c = clients();
  await ensureProjectNamespace('project-a', env, { clients: c });
  const body = (resource: string, name: string) => c.core[`create${resource}`].mock.calls.find(([a]: any) => a.body.metadata.name === name)[0].body;
  const item = body('NamespacedLimitRange', 'project-defaults').spec.limits[0];
  expect(item).toEqual({ type: 'Container', defaultRequest: { cpu: '100m', memory: '128Mi' }, _default: { cpu: '500m', memory: '512Mi' } });
  const ingress = body('NamespacedNetworkPolicy', 'allow-project').spec.ingress;
  expect(ingress).toEqual([{ _from: [{ podSelector: {} }] }]);
  for (const p of manifests().policies) {
    for (const rule of body('NamespacedNetworkPolicy', p.metadata.name).spec.ingress || []) {
      expect(rule).not.toHaveProperty('from');
      expect(rule._from?.length).toBeGreaterThan(0); // never an allow-from-anywhere rule
    }
  }
  expect(manifests().limits.spec.limits[0]).toHaveProperty('default'); // manifests stay wire format
});

it('reports the baseline applied when specs come back in typed client shape', async () => {
  const m = manifests(namespaceSettings('project-a', env.name));
  const asModel = (spec: any, key: 'limits' | 'ingress', wire: string, model: string) => {
    const out = JSON.parse(JSON.stringify(spec));
    for (const x of out[key] || []) if (wire in x) { x[model] = x[wire]; delete x[wire]; }
    return out;
  };
  const api: any = {
    readNamespace: async () => m.namespace,
    listNamespacedNetworkPolicy: async () => ({ items: m.policies.map(p => ({ ...p, spec: asModel(p.spec, 'ingress', 'from', '_from') })) }),
    readNamespacedResourceQuota: async () => m.quota,
    readNamespacedLimitRange: async () => ({ ...m.limits, spec: asModel(m.limits.spec, 'limits', 'default', '_default') }),
  };
  const status: any = await namespaceBaselineStatus('project-a', env, { core: api, network: api, rbac: api } as any);
  expect(status).toMatchObject({ policyApplied: true, limitsApplied: true, quotaApplied: true });
});
