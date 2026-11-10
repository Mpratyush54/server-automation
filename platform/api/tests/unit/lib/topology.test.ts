import { buildTopology, podHealth, deploymentHealth, certificateHealth, referencedConfigObjects, TopologySources } from '../../../src/lib/topology';

const NS = 'shop-staging-0123456789abcdef';
const NOW = new Date('2026-11-10T12:00:00Z');

function deployment(name: string, replicas: number, ready = replicas, extra: any = {}) {
  return {
    metadata: { name, uid: `uid-deploy-${name}`, generation: 2, creationTimestamp: new Date('2026-11-01T00:00:00Z') },
    spec: { replicas, selector: { matchLabels: { app: name } }, template: { spec: { containers: [{ name: 'app', image: `registry.local/${name}:v2` }] } } },
    status: { observedGeneration: 2, replicas, updatedReplicas: replicas, readyReplicas: ready, availableReplicas: ready },
    ...extra,
  };
}

function replicaSet(name: string, deploy: string, replicas: number, ready = replicas, revision = '2') {
  return {
    metadata: {
      name,
      uid: `uid-rs-${name}`,
      annotations: { 'deployment.kubernetes.io/revision': revision },
      ownerReferences: [{ kind: 'Deployment', name: deploy, uid: `uid-deploy-${deploy}`, controller: true }],
    },
    spec: { replicas, template: { spec: { containers: [{ name: 'app', image: `registry.local/${deploy}:v${revision}` }] } } },
    status: { replicas, readyReplicas: ready },
  };
}

function runningPod(name: string, rs: string, app: string, extra: any = {}) {
  return {
    metadata: {
      name,
      uid: `uid-pod-${name}`,
      labels: { app, 'pod-template-hash': 'abc' },
      ownerReferences: [{ kind: 'ReplicaSet', name: rs, uid: `uid-rs-${rs}`, controller: true }],
    },
    spec: {
      nodeName: 'node-1',
      containers: [{ name: 'app', image: `registry.local/${app}:v2`, envFrom: [{ secretRef: { name: `${app}-env` } }] }],
      volumes: [
        { name: 'cfg', configMap: { name: `${app}-config` } },
        { name: 'token', projected: { sources: [{ configMap: { name: 'kube-root-ca.crt' } }] } },
      ],
    },
    status: {
      phase: 'Running',
      startTime: '2026-11-10T11:00:00Z',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [{ name: 'app', ready: true, restartCount: 0, state: { running: {} } }],
    },
    ...extra,
  };
}

function service(name: string, selector: Record<string, string>) {
  return { metadata: { name, uid: `uid-svc-${name}` }, spec: { type: 'ClusterIP', selector, ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }] } };
}

function ingress(name: string, svc: string, tlsSecret: string, withLb = true) {
  return {
    metadata: { name, uid: `uid-ing-${name}` },
    spec: {
      ingressClassName: 'traefik',
      tls: [{ hosts: ['shop.example.test'], secretName: tlsSecret }],
      rules: [{ host: 'shop.example.test', http: { paths: [{ path: '/', backend: { service: { name: svc, port: { number: 80 } } } }] } }],
    },
    status: withLb ? { loadBalancer: { ingress: [{ hostname: 'lb.example.test' }] } } : {},
  };
}

function certificate(name: string, secretName: string, ready = 'True', ownerIngress?: string) {
  return {
    metadata: {
      name,
      uid: `uid-cert-${name}`,
      ownerReferences: ownerIngress ? [{ kind: 'Ingress', name: ownerIngress, uid: `uid-ing-${ownerIngress}` }] : undefined,
    },
    spec: { secretName, dnsNames: ['shop.example.test'], issuerRef: { name: 'letsencrypt' } },
    status: { conditions: [{ type: 'Ready', status: ready, message: ready === 'True' ? 'ok' : 'challenge pending' }], notAfter: '2027-02-01T00:00:00Z' },
  };
}

function argoApp(resources: any[], sync = 'Synced', health = 'Healthy') {
  return {
    metadata: { name: NS, namespace: 'argocd' },
    spec: { source: { repoURL: 'https://git.example.test/acme/shop.git', path: 'k8s', targetRevision: 'main' } },
    status: {
      sync: { status: sync, revision: 'abc123' },
      health: { status: health },
      operationState: { phase: 'Succeeded' },
      resources,
    },
  };
}

const managed = (kind: string, name: string, status = 'Synced', health?: string, group = '') => ({
  group, version: 'v1', kind, namespace: NS, name, status, ...(health ? { health: { status: health } } : {}),
});

/** Scaled deployment: 3 replicas, old RS kept at 0, service, ingress, owned certificate. */
function scaledFixture(): TopologySources {
  return {
    namespace: NS,
    appName: NS,
    app: argoApp([
      managed('Deployment', 'web', 'Synced', 'Healthy', 'apps'),
      managed('Service', 'web', 'Synced', 'Healthy'),
      managed('Ingress', 'web', 'Synced', 'Healthy', 'networking.k8s.io'),
    ]),
    deployments: [deployment('web', 3)],
    replicaSets: [replicaSet('web-7d9', 'web', 3), replicaSet('web-5c1', 'web', 0, 0, '1')],
    pods: [runningPod('web-7d9-a', 'web-7d9', 'web'), runningPod('web-7d9-b', 'web-7d9', 'web'), runningPod('web-7d9-c', 'web-7d9', 'web')],
    services: [service('web', { app: 'web' }), service('headless-none', {})],
    ingresses: [ingress('web', 'web', 'web-tls')],
    certificates: [certificate('web-tls', 'web-tls', 'True', 'web')],
    pvcs: [],
    events: [
      { involvedObject: { kind: 'Pod', name: 'web-7d9-a' }, type: 'Normal', reason: 'Pulled', message: 'old', lastTimestamp: '2026-11-10T10:00:00Z' },
      { involvedObject: { kind: 'Pod', name: 'web-7d9-a' }, type: 'Normal', reason: 'Started', message: 'new', lastTimestamp: '2026-11-10T11:00:00Z' },
      { involvedObject: { kind: 'Deployment', name: 'web' }, type: 'Normal', reason: 'ScalingReplicaSet', message: 'Scaled up to 3', count: 2, lastTimestamp: '2026-11-10T11:30:00Z' },
    ],
  };
}

const ids = (g: ReturnType<typeof buildTopology>) => g.nodes.map((n) => n.id).sort();
const edge = (g: ReturnType<typeof buildTopology>, from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
const node = (g: ReturnType<typeof buildTopology>, id: string) => g.nodes.find((n) => n.id === id)!;

describe('buildTopology — scaled deployment', () => {
  const sources = scaledFixture();
  sources.configMaps = referencedConfigObjects(sources).configMaps;
  sources.secrets = referencedConfigObjects(sources).secrets;
  const g = buildTopology(sources, NOW);

  it('has one node per live object, with counts matching kubectl get', () => {
    expect(g.counts).toEqual({
      Deployment: 1, ReplicaSet: 2, Pod: 3, Service: 2, Ingress: 1, Certificate: 1,
      ConfigMap: 1, Secret: 2, Application: 1,
    });
    expect(ids(g)).toEqual([
      `Application/${NS}`, 'Certificate/web-tls', 'ConfigMap/web-config', 'Deployment/web',
      'Ingress/web', 'Pod/web-7d9-a', 'Pod/web-7d9-b', 'Pod/web-7d9-c',
      'ReplicaSet/web-5c1', 'ReplicaSet/web-7d9', 'Secret/web-env', 'Secret/web-tls',
      'Service/headless-none', 'Service/web',
    ]);
    expect(g.generatedAt).toBe(NOW.toISOString());
  });

  it('builds owns edges from ownerReferences and the Argo Application', () => {
    expect(edge(g, `Application/${NS}`, 'Deployment/web')).toEqual({ from: `Application/${NS}`, to: 'Deployment/web', type: 'owns' });
    expect(edge(g, 'Deployment/web', 'ReplicaSet/web-7d9')?.type).toBe('owns');
    expect(edge(g, 'Deployment/web', 'ReplicaSet/web-5c1')?.type).toBe('owns');
    for (const p of ['a', 'b', 'c']) expect(edge(g, 'ReplicaSet/web-7d9', `Pod/web-7d9-${p}`)?.type).toBe('owns');
    // Pods are not managed by Argo directly.
    expect(edge(g, `Application/${NS}`, 'Pod/web-7d9-a')).toBeUndefined();
  });

  it('links Service→Pods by selector, Ingress→Service by backend, Certificate by TLS secretName', () => {
    for (const p of ['a', 'b', 'c']) expect(edge(g, 'Service/web', `Pod/web-7d9-${p}`)?.type).toBe('selects');
    expect(node(g, 'Service/web').info.endpoints).toBe(3);
    // Empty selector selects nothing.
    expect(g.edges.filter((e) => e.from === 'Service/headless-none')).toHaveLength(0);
    expect(edge(g, 'Ingress/web', 'Service/web')?.type).toBe('routes');
    // ownerReference wins over the secretName reference: one edge, type owns.
    expect(g.edges.filter((e) => e.from === 'Ingress/web' && e.to === 'Certificate/web-tls')).toEqual([
      { from: 'Ingress/web', to: 'Certificate/web-tls', type: 'owns' },
    ]);
    expect(edge(g, 'Certificate/web-tls', 'Secret/web-tls')?.type).toBe('selects');
    // Pods → the ConfigMaps / Secrets they mount or read env from.
    expect(edge(g, 'Pod/web-7d9-a', 'ConfigMap/web-config')?.type).toBe('selects');
    expect(edge(g, 'Pod/web-7d9-b', 'Secret/web-env')?.type).toBe('selects');
    expect(g.nodes.find((n) => n.name === 'kube-root-ca.crt')).toBeUndefined();
  });

  it('reports replica info, inactive old ReplicaSets, health and sync', () => {
    const d = node(g, 'Deployment/web');
    expect(d.health).toBe('Healthy');
    expect(d.sync).toBe('Synced');
    expect(d.info).toMatchObject({ replicas: 3, readyReplicas: 3, images: ['registry.local/web:v2'] });
    expect(node(g, 'ReplicaSet/web-5c1').info.inactive).toBe(true);
    expect(node(g, 'ReplicaSet/web-7d9').info.inactive).toBe(false);
    expect(node(g, 'Pod/web-7d9-a')).toMatchObject({ health: 'Healthy', sync: null });
    expect(node(g, 'Pod/web-7d9-a').info).toMatchObject({ ready: '1/1', restarts: 0, node: 'node-1' });
    expect(g.argo).toEqual({ found: true, error: null, sync: 'Synced', health: 'Healthy', revision: 'abc123' });
  });

  it('attaches newest-first events to their nodes', () => {
    expect(node(g, 'Pod/web-7d9-a').events.map((e) => e.reason)).toEqual(['Started', 'Pulled']);
    expect(node(g, 'Deployment/web').events[0]).toMatchObject({ reason: 'ScalingReplicaSet', count: 2 });
    expect(node(g, 'Pod/web-7d9-b').events).toEqual([]);
  });

  it('only emits edges between existing nodes, without duplicates', () => {
    const all = new Set(g.nodes.map((n) => n.id));
    const pairs = new Set<string>();
    for (const e of g.edges) {
      expect(all.has(e.from) && all.has(e.to)).toBe(true);
      expect(['owns', 'routes', 'selects']).toContain(e.type);
      const k = `${e.from}->${e.to}`;
      expect(pairs.has(k)).toBe(false);
      pairs.add(k);
    }
  });
});

describe('buildTopology — scaling', () => {
  it('pod nodes follow the live pod list (scale 3 → 1)', () => {
    const s = scaledFixture();
    s.deployments = [deployment('web', 1)];
    s.replicaSets = [replicaSet('web-7d9', 'web', 1)];
    s.pods = [runningPod('web-7d9-a', 'web-7d9', 'web')];
    const g = buildTopology(s, NOW);
    expect(g.counts.Pod).toBe(1);
    expect(node(g, 'Service/web').info.endpoints).toBe(1);
  });

  it('a deployment mid-rollout is Progressing', () => {
    const d = deployment('web', 3, 1);
    expect(deploymentHealth(d)).toBe('Progressing');
    expect(deploymentHealth({ ...d, status: { ...d.status, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' }] } })).toBe('Degraded');
    expect(deploymentHealth({ ...deployment('web', 3), spec: { replicas: 3, paused: true } })).toBe('Suspended');
  });
});

describe('buildTopology — degraded pod', () => {
  const crashing = runningPod('web-7d9-x', 'web-7d9', 'web', {
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [{ name: 'app', ready: false, restartCount: 7, state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    },
  });

  it('marks CrashLoopBackOff pods Degraded with the reason', () => {
    const s = scaledFixture();
    s.pods = [...(s.pods || []), crashing];
    const g = buildTopology(s, NOW);
    expect(node(g, 'Pod/web-7d9-x')).toMatchObject({ health: 'Degraded' });
    expect(node(g, 'Pod/web-7d9-x').info).toMatchObject({ reason: 'CrashLoopBackOff', restarts: 7, ready: '0/1' });
  });

  it.each([
    [{ status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] } }, 'Degraded', 'Unschedulable'],
    [{ status: { phase: 'Pending' } }, 'Progressing', 'Pending'],
    [{ status: { phase: 'Failed', reason: 'Evicted' } }, 'Degraded', 'Evicted'],
    [{ status: { phase: 'Succeeded' } }, 'Healthy', 'Completed'],
    [{ status: { phase: 'Running', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] } }, 'Degraded', 'ImagePullBackOff'],
    [{ status: { phase: 'Running', containerStatuses: [{ restartCount: 2, state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }] } }, 'Degraded', 'OOMKilled'],
    [{ metadata: { deletionTimestamp: '2026-11-10T11:59:00Z' }, status: { phase: 'Running' } }, 'Progressing', 'Terminating'],
    [{ status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'False' }] } }, 'Progressing', 'NotReady'],
  ])('podHealth %#', (pod, health, reason) => {
    expect(podHealth(pod)).toEqual({ health, reason });
  });

  it('certificate health', () => {
    expect(certificateHealth(certificate('c', 's', 'True'))).toBe('Healthy');
    expect(certificateHealth(certificate('c', 's', 'False'))).toBe('Degraded');
    expect(certificateHealth({ status: { conditions: [{ type: 'Ready', status: 'False' }, { type: 'Issuing', status: 'True' }] } })).toBe('Progressing');
    expect(certificateHealth({})).toBe('Progressing');
  });
});

describe('buildTopology — OutOfSync resource', () => {
  it('marks OutOfSync live resources and adds Missing managed resources', () => {
    const s = scaledFixture();
    s.app = argoApp(
      [
        managed('Deployment', 'web', 'OutOfSync', 'Healthy', 'apps'),
        managed('Service', 'web'),
        managed('ConfigMap', 'feature-flags', 'OutOfSync', 'Missing'),
        managed('HorizontalPodAutoscaler', 'web', 'Synced', 'Healthy', 'autoscaling'),
        { ...managed('ServiceAccount', 'old-sa', 'OutOfSync'), requiresPruning: true },
        // Other namespaces / cluster-scoped entries are never added.
        { kind: 'Namespace', name: NS, status: 'Synced' },
        { kind: 'Service', namespace: 'other-ns', name: 'leak', status: 'Synced' },
      ],
      'OutOfSync',
      'Healthy',
    );
    const g = buildTopology(s, NOW);
    expect(g.argo.sync).toBe('OutOfSync');
    expect(node(g, `Application/${NS}`)).toMatchObject({ sync: 'OutOfSync', health: 'Healthy' });
    expect(node(g, 'Deployment/web').sync).toBe('OutOfSync');
    expect(node(g, 'Service/web').sync).toBe('Synced');
    expect(node(g, 'ConfigMap/feature-flags')).toMatchObject({ sync: 'OutOfSync', health: 'Missing', info: { live: false, managed: true } });
    expect(node(g, 'HorizontalPodAutoscaler/web')).toMatchObject({ sync: 'Synced', health: 'Healthy' });
    expect(node(g, 'ServiceAccount/old-sa')).toMatchObject({ sync: 'OutOfSync', health: null });
    expect(node(g, 'ServiceAccount/old-sa').info.requiresPruning).toBe(true);
    expect(edge(g, `Application/${NS}`, 'ConfigMap/feature-flags')?.type).toBe('owns');
    expect(g.nodes.find((n) => n.name === 'leak')).toBeUndefined();
    expect(g.nodes.find((n) => n.kind === 'Namespace')).toBeUndefined();
  });
});

describe('buildTopology — missing Argo app', () => {
  it('still returns the live graph, without an Application node', () => {
    const s = scaledFixture();
    s.app = null;
    s.appError = `ArgoCD Application '${NS}' not found`;
    const g = buildTopology(s, NOW);
    expect(g.argo).toEqual({ found: false, error: s.appError, sync: null, health: null, revision: null });
    expect(g.nodes.find((n) => n.kind === 'Application')).toBeUndefined();
    expect(g.nodes.every((n) => n.sync === null)).toBe(true);
    expect(g.counts.Pod).toBe(3);
    expect(edge(g, 'Ingress/web', 'Service/web')?.type).toBe('routes');
  });

  it('handles an empty namespace', () => {
    const g = buildTopology({ namespace: NS, appName: NS, app: null }, NOW);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.counts).toEqual({});
  });
});

describe('buildTopology — references and secrecy', () => {
  it('links Ingress TLS to the Secret when no Certificate exists, and Pods to PVCs', () => {
    const s: TopologySources = {
      namespace: NS,
      appName: NS,
      app: null,
      ingresses: [ingress('web', 'missing-svc', 'manual-tls', false)],
      pods: [{ ...runningPod('db-0', 'none', 'db'), spec: { containers: [], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-db-0' } }] } }],
      pvcs: [
        { metadata: { name: 'data-db-0' }, spec: { storageClassName: 'local-path', accessModes: ['ReadWriteOnce'] }, status: { phase: 'Bound', capacity: { storage: '1Gi' } } },
        { metadata: { name: 'pending' }, status: { phase: 'Pending' } },
      ],
      secrets: [{ metadata: { name: 'manual-tls' } }],
    };
    const g = buildTopology(s, NOW);
    expect(edge(g, 'Ingress/web', 'Secret/manual-tls')?.type).toBe('selects');
    expect(node(g, 'Ingress/web')).toMatchObject({ health: 'Progressing', info: { missingBackends: ['missing-svc'] } });
    expect(edge(g, 'Pod/db-0', 'PersistentVolumeClaim/data-db-0')?.type).toBe('selects');
    expect(node(g, 'PersistentVolumeClaim/data-db-0')).toMatchObject({ health: 'Healthy', info: { capacity: '1Gi' } });
    expect(node(g, 'PersistentVolumeClaim/pending').health).toBe('Progressing');
  });

  it('never copies Secret or ConfigMap data into the graph', () => {
    const g = buildTopology({
      namespace: NS,
      appName: NS,
      app: null,
      secrets: [{ metadata: { name: 'db', annotations: { note: 'ANNOTATION-VALUE' } }, type: 'Opaque', data: { password: 'U0VDUkVULVZBTFVF' }, stringData: { x: 'SECRET-VALUE' } }],
      configMaps: [{ metadata: { name: 'cfg' }, data: { key: 'CONFIG-VALUE' } }],
    }, NOW);
    const json = JSON.stringify(g);
    expect(json).not.toMatch(/SECRET-VALUE|U0VDUkVULVZBTFVF|CONFIG-VALUE|ANNOTATION-VALUE|password/);
    expect(node(g, 'Secret/db')).toMatchObject({ kind: 'Secret', name: 'db', health: null, info: { type: 'Opaque' } });
  });

  it('referencedConfigObjects collects names from volumes, env, envFrom, pull secrets, TLS and certificates', () => {
    const refs = referencedConfigObjects({
      pods: [{
        spec: {
          imagePullSecrets: [{ name: 'regcred' }],
          volumes: [{ secret: { secretName: 'vol-secret' } }, { configMap: { name: 'vol-cm' } }, { projected: { sources: [{ configMap: { name: 'kube-root-ca.crt' } }, { secret: { name: 'proj-secret' } }] } }],
          initContainers: [{ env: [{ valueFrom: { configMapKeyRef: { name: 'init-cm' } } }] }],
          containers: [{ envFrom: [{ configMapRef: { name: 'ef-cm' } }], env: [{ valueFrom: { secretKeyRef: { name: 'key-secret' } } }, { name: 'PLAIN', value: 'x' }] }],
        },
      }],
      ingresses: [ingress('web', 'web', 'ing-tls')],
      certificates: [certificate('c', 'cert-tls')],
    });
    expect(refs.configMaps.map((c) => c.metadata.name)).toEqual(['ef-cm', 'init-cm', 'vol-cm']);
    expect(refs.secrets.map((s) => s.metadata.name)).toEqual(['cert-tls', 'ing-tls', 'key-secret', 'proj-secret', 'regcred', 'vol-secret']);
  });
});
