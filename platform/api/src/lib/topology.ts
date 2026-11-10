/**
 * Live resource topology for one project environment (issue #31).
 *
 * Pure graph builder: takes raw Kubernetes objects (as returned by
 * @kubernetes/client-node or the custom-objects API) for a single namespace plus
 * the ArgoCD Application (or null), and returns nodes + edges for the portal.
 * No I/O here — fetching lives in topology-k8s.ts so this stays unit-testable.
 *
 * Secrets: only metadata.name / metadata.uid / type are ever read. Secret data
 * never reaches a node.
 */

export type TopologyHealth =
  | 'Healthy'
  | 'Progressing'
  | 'Degraded'
  | 'Suspended'
  | 'Missing'
  | 'Unknown';

export type TopologySync = 'Synced' | 'OutOfSync' | 'Unknown';

export type TopologyEdgeType = 'owns' | 'routes' | 'selects';

export interface TopologyEvent {
  type: string;
  reason: string;
  message: string;
  count: number;
  lastTimestamp: string | null;
}

export interface TopologyNode {
  id: string;
  kind: string;
  name: string;
  health: TopologyHealth | null;
  sync: TopologySync | null;
  info: Record<string, unknown>;
  events: TopologyEvent[];
}

export interface TopologyEdge {
  from: string;
  to: string;
  type: TopologyEdgeType;
}

export interface TopologySources {
  namespace: string;
  appName: string;
  /** ArgoCD Application object, or null when it does not exist / is unreachable. */
  app: any | null;
  appError?: string | null;
  deployments?: any[];
  replicaSets?: any[];
  pods?: any[];
  services?: any[];
  ingresses?: any[];
  certificates?: any[];
  pvcs?: any[];
  configMaps?: any[];
  secrets?: any[];
  events?: any[];
}

export interface TopologyGraph {
  namespace: string;
  appName: string;
  argo: {
    found: boolean;
    error: string | null;
    sync: TopologySync | null;
    health: TopologyHealth | null;
    revision: string | null;
  };
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** Node counts per kind — compare with `kubectl get <kind> -n <namespace>`. */
  counts: Record<string, number>;
  generatedAt: string;
}

const HEALTH_VALUES: TopologyHealth[] = ['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown'];
const SYNC_VALUES: TopologySync[] = ['Synced', 'OutOfSync', 'Unknown'];
const MAX_EVENTS_PER_NODE = 10;

/** Container waiting reasons that mean the pod will not become ready on its own. */
const DEGRADED_WAIT_REASONS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
  'RunContainerError',
]);

export function nodeId(kind: string, name: string): string {
  return `${kind}/${name}`;
}

function normHealth(v: unknown): TopologyHealth | null {
  return typeof v === 'string' && (HEALTH_VALUES as string[]).includes(v) ? (v as TopologyHealth) : null;
}

function normSync(v: unknown): TopologySync | null {
  return typeof v === 'string' && (SYNC_VALUES as string[]).includes(v) ? (v as TopologySync) : null;
}

function ts(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function conditions(obj: any): any[] {
  return Array.isArray(obj?.status?.conditions) ? obj.status.conditions : [];
}

function condition(obj: any, type: string): any | undefined {
  return conditions(obj).find((c) => c?.type === type);
}

function labelsMatch(selector: Record<string, string> | undefined | null, labels: Record<string, string> | undefined | null): boolean {
  const entries = Object.entries(selector || {});
  if (entries.length === 0) return false; // empty selector selects nothing for Services
  const l = labels || {};
  return entries.every(([k, v]) => l[k] === v);
}

// ── Health per kind (mirrors ArgoCD's built-in health checks, simplified) ──────

export function deploymentHealth(d: any): TopologyHealth {
  if (d?.spec?.paused) return 'Suspended';
  const desired = d?.spec?.replicas ?? 1;
  const st = d?.status || {};
  const progressing = condition(d, 'Progressing');
  if (progressing?.status === 'False' && progressing?.reason === 'ProgressDeadlineExceeded') return 'Degraded';
  if ((d?.metadata?.generation ?? 0) > (st.observedGeneration ?? 0)) return 'Progressing';
  if ((st.updatedReplicas ?? 0) < desired) return 'Progressing';
  if ((st.replicas ?? 0) > (st.updatedReplicas ?? 0)) return 'Progressing'; // old pods terminating
  if ((st.availableReplicas ?? 0) < desired) return 'Progressing';
  return 'Healthy';
}

export function replicaSetHealth(rs: any): TopologyHealth {
  const desired = rs?.spec?.replicas ?? 1;
  const st = rs?.status || {};
  const failure = condition(rs, 'ReplicaFailure');
  if (failure?.status === 'True') return 'Degraded';
  if ((st.readyReplicas ?? 0) < desired) return 'Progressing';
  return 'Healthy';
}

/** Returns health plus a short human reason for non-healthy pods. */
export function podHealth(p: any): { health: TopologyHealth; reason: string | null } {
  const phase = p?.status?.phase;
  const statuses: any[] = [
    ...(p?.status?.initContainerStatuses || []),
    ...(p?.status?.containerStatuses || []),
  ];
  for (const cs of statuses) {
    const waiting = cs?.state?.waiting?.reason;
    if (waiting && DEGRADED_WAIT_REASONS.has(waiting)) return { health: 'Degraded', reason: waiting };
    const term = cs?.state?.terminated;
    if (term && phase !== 'Succeeded' && term.exitCode !== 0 && (cs?.restartCount ?? 0) > 0) {
      return { health: 'Degraded', reason: term.reason || `exit ${term.exitCode}` };
    }
  }
  if (p?.metadata?.deletionTimestamp) return { health: 'Progressing', reason: 'Terminating' };
  if (phase === 'Failed') return { health: 'Degraded', reason: p?.status?.reason || 'Failed' };
  if (phase === 'Succeeded') return { health: 'Healthy', reason: 'Completed' };
  if (phase === 'Pending') {
    const sched = condition(p, 'PodScheduled');
    if (sched?.status === 'False' && sched?.reason === 'Unschedulable') return { health: 'Degraded', reason: 'Unschedulable' };
    return { health: 'Progressing', reason: 'Pending' };
  }
  if (phase === 'Running') {
    const ready = condition(p, 'Ready');
    if (ready && ready.status !== 'True') return { health: 'Progressing', reason: 'NotReady' };
    return { health: 'Healthy', reason: null };
  }
  return { health: 'Unknown', reason: phase || null };
}

export function ingressHealth(i: any): TopologyHealth {
  const lb = i?.status?.loadBalancer?.ingress;
  return Array.isArray(lb) && lb.length > 0 ? 'Healthy' : 'Progressing';
}

export function certificateHealth(c: any): TopologyHealth {
  const ready = condition(c, 'Ready');
  if (ready?.status === 'True') return 'Healthy';
  const issuing = condition(c, 'Issuing');
  if (issuing?.status === 'True') return 'Progressing';
  if (ready?.status === 'False') return 'Degraded';
  return 'Progressing';
}

export function pvcHealth(pvc: any): TopologyHealth {
  const phase = pvc?.status?.phase;
  if (phase === 'Bound') return 'Healthy';
  if (phase === 'Lost') return 'Degraded';
  return 'Progressing';
}

// ── Info per kind ─────────────────────────────────────────────────────────────

function containerImages(spec: any): string[] {
  return (spec?.containers || []).map((c: any) => c?.image).filter(Boolean);
}

function deploymentInfo(d: any): Record<string, unknown> {
  const st = d?.status || {};
  return {
    replicas: d?.spec?.replicas ?? 1,
    readyReplicas: st.readyReplicas ?? 0,
    availableReplicas: st.availableReplicas ?? 0,
    updatedReplicas: st.updatedReplicas ?? 0,
    images: containerImages(d?.spec?.template?.spec),
  };
}

function replicaSetInfo(rs: any): Record<string, unknown> {
  const st = rs?.status || {};
  const desired = rs?.spec?.replicas ?? 1;
  return {
    replicas: desired,
    readyReplicas: st.readyReplicas ?? 0,
    revision: rs?.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? null,
    images: containerImages(rs?.spec?.template?.spec),
    /** Old revision kept for rollback (0 desired, 0 running). */
    inactive: desired === 0 && (st.replicas ?? 0) === 0,
  };
}

function podInfo(p: any, reason: string | null): Record<string, unknown> {
  const statuses: any[] = p?.status?.containerStatuses || [];
  const total = (p?.spec?.containers || []).length || statuses.length;
  return {
    phase: p?.status?.phase ?? null,
    ready: `${statuses.filter((c) => c?.ready).length}/${total}`,
    restarts: statuses.reduce((n, c) => n + (c?.restartCount || 0), 0),
    node: p?.spec?.nodeName ?? null,
    reason,
    images: containerImages(p?.spec),
    startedAt: ts(p?.status?.startTime),
  };
}

function serviceInfo(s: any): Record<string, unknown> {
  return {
    type: s?.spec?.type ?? 'ClusterIP',
    ports: (s?.spec?.ports || []).map((pt: any) => `${pt?.port}${pt?.targetPort !== undefined ? `→${pt.targetPort}` : ''}/${pt?.protocol || 'TCP'}`),
    selector: s?.spec?.selector || {},
  };
}

function ingressBackendServices(i: any): string[] {
  const names = new Set<string>();
  const def = i?.spec?.defaultBackend?.service?.name;
  if (def) names.add(def);
  for (const rule of i?.spec?.rules || []) {
    for (const path of rule?.http?.paths || []) {
      const svc = path?.backend?.service?.name;
      if (svc) names.add(svc);
    }
  }
  return [...names];
}

function ingressTlsSecrets(i: any): string[] {
  return (i?.spec?.tls || []).map((t: any) => t?.secretName).filter(Boolean);
}

function ingressInfo(i: any): Record<string, unknown> {
  return {
    ingressClassName: i?.spec?.ingressClassName ?? i?.metadata?.annotations?.['kubernetes.io/ingress.class'] ?? null,
    hosts: (i?.spec?.rules || []).map((r: any) => r?.host).filter(Boolean),
    tlsHosts: (i?.spec?.tls || []).flatMap((t: any) => t?.hosts || []),
    backends: ingressBackendServices(i),
  };
}

function certificateInfo(c: any): Record<string, unknown> {
  const ready = condition(c, 'Ready');
  return {
    secretName: c?.spec?.secretName ?? null,
    dnsNames: c?.spec?.dnsNames || [],
    issuer: c?.spec?.issuerRef?.name ?? null,
    notAfter: ts(c?.status?.notAfter),
    renewalTime: ts(c?.status?.renewalTime),
    message: ready && ready.status !== 'True' ? ready.message ?? null : null,
  };
}

function pvcInfo(pvc: any): Record<string, unknown> {
  return {
    phase: pvc?.status?.phase ?? null,
    capacity: pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage ?? null,
    storageClassName: pvc?.spec?.storageClassName ?? null,
    accessModes: pvc?.spec?.accessModes || [],
  };
}

/** ConfigMap / Secret names one pod references (volumes, env, envFrom, pull secrets). */
export function podConfigRefs(p: any): { configMaps: string[]; secrets: string[] } {
  const cms = new Set<string>();
  const secrets = new Set<string>();
  const spec = p?.spec || {};
  for (const v of spec.volumes || []) {
    if (v?.configMap?.name) cms.add(v.configMap.name);
    if (v?.secret?.secretName) secrets.add(v.secret.secretName);
    for (const s of v?.projected?.sources || []) {
      if (s?.configMap?.name) cms.add(s.configMap.name);
      if (s?.secret?.name) secrets.add(s.secret.name);
    }
  }
  for (const c of [...(spec.initContainers || []), ...(spec.containers || [])]) {
    for (const ef of c?.envFrom || []) {
      if (ef?.configMapRef?.name) cms.add(ef.configMapRef.name);
      if (ef?.secretRef?.name) secrets.add(ef.secretRef.name);
    }
    for (const e of c?.env || []) {
      if (e?.valueFrom?.configMapKeyRef?.name) cms.add(e.valueFrom.configMapKeyRef.name);
      if (e?.valueFrom?.secretKeyRef?.name) secrets.add(e.valueFrom.secretKeyRef.name);
    }
  }
  for (const ips of spec.imagePullSecrets || []) if (ips?.name) secrets.add(ips.name);
  // Projected service-account token volumes reference this per-namespace ConfigMap; it is noise.
  cms.delete('kube-root-ca.crt');
  return { configMaps: [...cms], secrets: [...secrets] };
}

/**
 * Secret / ConfigMap names referenced by pods, ingresses and certificates, as
 * minimal metadata-only objects. The API never lists Secrets/ConfigMaps (no
 * RBAC for it, and no way to read a value by accident): these nodes are derived.
 */
export function referencedConfigObjects(src: Pick<TopologySources, 'pods' | 'ingresses' | 'certificates'>): {
  configMaps: any[];
  secrets: any[];
} {
  const cms = new Set<string>();
  const secrets = new Set<string>();
  for (const p of src.pods || []) {
    const refs = podConfigRefs(p);
    refs.configMaps.forEach((n) => cms.add(n));
    refs.secrets.forEach((n) => secrets.add(n));
  }
  for (const i of src.ingresses || []) for (const t of i?.spec?.tls || []) if (t?.secretName) secrets.add(t.secretName);
  for (const c of src.certificates || []) if (c?.spec?.secretName) secrets.add(c.spec.secretName);
  return {
    configMaps: [...cms].sort().map((name) => ({ metadata: { name } })),
    secrets: [...secrets].sort().map((name) => ({ metadata: { name } })),
  };
}

// ── Builder ──────────────────────────────────────────────────────────────────

function eventKey(kind: string, name: string): string {
  return `${kind}/${name}`;
}

function groupEvents(events: any[]): Map<string, TopologyEvent[]> {
  const byObj = new Map<string, TopologyEvent[]>();
  for (const e of events) {
    const kind = e?.involvedObject?.kind ?? e?.regarding?.kind;
    const name = e?.involvedObject?.name ?? e?.regarding?.name;
    if (!kind || !name) continue;
    const ev: TopologyEvent = {
      type: e?.type || 'Normal',
      reason: e?.reason || '',
      message: e?.message || e?.note || '',
      count: e?.count ?? e?.series?.count ?? 1,
      lastTimestamp: ts(e?.lastTimestamp) || ts(e?.eventTime) || ts(e?.metadata?.creationTimestamp),
    };
    const key = eventKey(kind, name);
    const list = byObj.get(key) || [];
    list.push(ev);
    byObj.set(key, list);
  }
  for (const [k, list] of byObj) {
    list.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
    byObj.set(k, list.slice(0, MAX_EVENTS_PER_NODE));
  }
  return byObj;
}

export function buildTopology(src: TopologySources, now: Date = new Date()): TopologyGraph {
  const nodes = new Map<string, TopologyNode>();
  const uidToId = new Map<string, string>();
  const edges: TopologyEdge[] = [];
  const edgeKeys = new Set<string>();
  const events = groupEvents(src.events || []);

  const addEdge = (from: string, to: string, type: TopologyEdgeType) => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return;
    // One edge per pair: an ownership edge wins over a reference edge.
    const pair = `${from}->${to}`;
    if (edgeKeys.has(pair)) return;
    edgeKeys.add(pair);
    edges.push({ from, to, type });
  };

  const addNode = (kind: string, obj: any, health: TopologyHealth | null, info: Record<string, unknown>) => {
    const name = obj?.metadata?.name;
    if (!name) return;
    const id = nodeId(kind, name);
    nodes.set(id, {
      id,
      kind,
      name,
      health,
      sync: null,
      info: { createdAt: ts(obj?.metadata?.creationTimestamp), ...info },
      events: events.get(eventKey(kind, name)) || [],
    });
    const uid = obj?.metadata?.uid;
    if (uid) uidToId.set(uid, id);
  };

  // Live objects
  for (const d of src.deployments || []) addNode('Deployment', d, deploymentHealth(d), deploymentInfo(d));
  for (const rs of src.replicaSets || []) addNode('ReplicaSet', rs, replicaSetHealth(rs), replicaSetInfo(rs));
  for (const p of src.pods || []) {
    const h = podHealth(p);
    addNode('Pod', p, h.health, podInfo(p, h.reason));
  }
  for (const s of src.services || []) addNode('Service', s, 'Healthy', serviceInfo(s));
  for (const i of src.ingresses || []) addNode('Ingress', i, ingressHealth(i), ingressInfo(i));
  for (const c of src.certificates || []) addNode('Certificate', c, certificateHealth(c), certificateInfo(c));
  for (const pvc of src.pvcs || []) addNode('PersistentVolumeClaim', pvc, pvcHealth(pvc), pvcInfo(pvc));
  for (const cm of src.configMaps || []) addNode('ConfigMap', { metadata: { name: cm?.metadata?.name, uid: cm?.metadata?.uid, creationTimestamp: cm?.metadata?.creationTimestamp } }, null, {});
  for (const s of src.secrets || []) {
    // Names only — never copy data/stringData.
    addNode('Secret', { metadata: { name: s?.metadata?.name, uid: s?.metadata?.uid, creationTimestamp: s?.metadata?.creationTimestamp } }, null, { type: s?.type ?? null });
  }

  // ArgoCD Application: sync/health per managed resource, plus Missing resources
  const app = src.app;
  const appStatus = app?.status || {};
  let appNodeId: string | null = null;
  if (app) {
    const name = app?.metadata?.name || src.appName;
    appNodeId = nodeId('Application', name);
    const appConds = Array.isArray(appStatus.conditions) ? appStatus.conditions : [];
    nodes.set(appNodeId, {
      id: appNodeId,
      kind: 'Application',
      name,
      health: normHealth(appStatus.health?.status) ?? 'Unknown',
      sync: normSync(appStatus.sync?.status) ?? 'Unknown',
      info: {
        revision: appStatus.sync?.revision ?? null,
        repoURL: app?.spec?.source?.repoURL ?? null,
        path: app?.spec?.source?.path ?? null,
        targetRevision: app?.spec?.source?.targetRevision ?? null,
        operationPhase: appStatus.operationState?.phase ?? null,
        operationMessage: appStatus.operationState?.message ?? null,
        reconciledAt: ts(appStatus.reconciledAt),
        conditions: appConds.map((c: any) => ({ type: c?.type, message: c?.message })),
      },
      events: events.get(eventKey('Application', name)) || [],
    });

    for (const r of Array.isArray(appStatus.resources) ? appStatus.resources : []) {
      if (!r?.kind || !r?.name) continue;
      // Scope to the project namespace; cluster-scoped / foreign namespaces are skipped.
      if (r.namespace !== src.namespace) continue;
      const id = nodeId(r.kind, r.name);
      let n = nodes.get(id);
      if (!n) {
        // Managed by Argo but not in our live lists: either another kind
        // (HPA, ServiceAccount, …) or not created yet (Missing).
        n = {
          id,
          kind: r.kind,
          name: r.name,
          health: normHealth(r.health?.status), // Argo reports 'Missing' for resources not created yet
          sync: null,
          info: { group: r.group || null, version: r.version || null, live: false },
          events: events.get(eventKey(r.kind, r.name)) || [],
        };
        nodes.set(id, n);
      } else if (!n.health) {
        n.health = normHealth(r.health?.status);
      }
      n.sync = normSync(r.status) ?? 'Unknown';
      if (r.requiresPruning) n.info.requiresPruning = true;
      if (r.health?.message) n.info.healthMessage = r.health.message;
      n.info.managed = true;
      addEdge(appNodeId, id, 'owns');
    }
  }

  // ownerReferences → owns
  const ownerEdges = (kind: string, list: any[] | undefined) => {
    for (const obj of list || []) {
      const childId = nodeId(kind, obj?.metadata?.name);
      for (const ref of obj?.metadata?.ownerReferences || []) {
        const ownerId = (ref?.uid && uidToId.get(ref.uid)) || (ref?.kind && ref?.name ? nodeId(ref.kind, ref.name) : null);
        if (ownerId) addEdge(ownerId, childId, 'owns');
      }
    }
  };
  ownerEdges('ReplicaSet', src.replicaSets);
  ownerEdges('Pod', src.pods);
  ownerEdges('Deployment', src.deployments);
  ownerEdges('Service', src.services);
  ownerEdges('Ingress', src.ingresses);
  ownerEdges('Certificate', src.certificates);
  ownerEdges('PersistentVolumeClaim', src.pvcs);
  ownerEdges('ConfigMap', src.configMaps);
  ownerEdges('Secret', src.secrets);

  // Ingress backends → Services (routes)
  for (const i of src.ingresses || []) {
    const ingId = nodeId('Ingress', i?.metadata?.name);
    const missing: string[] = [];
    for (const svc of ingressBackendServices(i)) {
      const svcId = nodeId('Service', svc);
      if (nodes.has(svcId)) addEdge(ingId, svcId, 'routes');
      else missing.push(svc);
    }
    if (missing.length && nodes.has(ingId)) nodes.get(ingId)!.info.missingBackends = missing;
  }

  // Service selectors → Pods (selects)
  for (const s of src.services || []) {
    const svcId = nodeId('Service', s?.metadata?.name);
    const sel = s?.spec?.selector;
    let matched = 0;
    for (const p of src.pods || []) {
      if (labelsMatch(sel, p?.metadata?.labels)) {
        addEdge(svcId, nodeId('Pod', p?.metadata?.name), 'selects');
        matched++;
      }
    }
    if (nodes.has(svcId)) nodes.get(svcId)!.info.endpoints = matched;
  }

  // Certificate secretName ↔ Ingress TLS (and → Secret)
  const certBySecret = new Map<string, string>();
  for (const c of src.certificates || []) {
    const secretName = c?.spec?.secretName;
    if (!secretName) continue;
    const certId = nodeId('Certificate', c?.metadata?.name);
    certBySecret.set(secretName, certId);
    addEdge(certId, nodeId('Secret', secretName), 'selects');
  }
  for (const i of src.ingresses || []) {
    const ingId = nodeId('Ingress', i?.metadata?.name);
    for (const secretName of ingressTlsSecrets(i)) {
      const certId = certBySecret.get(secretName);
      // cert-manager's ingress-shim makes the Ingress own the Certificate; if the
      // owns edge already exists, addEdge keeps it.
      if (certId) addEdge(ingId, certId, 'selects');
      else addEdge(ingId, nodeId('Secret', secretName), 'selects');
    }
  }

  // Pod volumes → PVCs, and Pod → referenced ConfigMaps / Secrets (selects)
  for (const p of src.pods || []) {
    const podId = nodeId('Pod', p?.metadata?.name);
    for (const v of p?.spec?.volumes || []) {
      const claim = v?.persistentVolumeClaim?.claimName;
      if (claim) addEdge(podId, nodeId('PersistentVolumeClaim', claim), 'selects');
    }
    const refs = podConfigRefs(p);
    for (const cm of refs.configMaps) addEdge(podId, nodeId('ConfigMap', cm), 'selects');
    for (const sec of refs.secrets) addEdge(podId, nodeId('Secret', sec), 'selects');
  }

  const nodeList = [...nodes.values()];
  const counts: Record<string, number> = {};
  for (const n of nodeList) counts[n.kind] = (counts[n.kind] || 0) + 1;

  return {
    namespace: src.namespace,
    appName: src.appName,
    argo: {
      found: !!app,
      error: app ? null : src.appError || null,
      sync: app ? normSync(appStatus.sync?.status) ?? 'Unknown' : null,
      health: app ? normHealth(appStatus.health?.status) ?? 'Unknown' : null,
      revision: app ? appStatus.sync?.revision ?? null : null,
    },
    nodes: nodeList,
    edges,
    counts,
    generatedAt: now.toISOString(),
  };
}
