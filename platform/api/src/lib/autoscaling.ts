import { assignedNamespace } from './project-namespace';

export const autoscalingNamespace = (env: { name: string; namespace: string; projectId: string }) => env.name === 'preview' ? assignedNamespace('project', 'preview', env.projectId) : env.namespace;

export interface AutoscalingSettings {
  enabled: boolean;
  minReplicas: number;
  maxReplicas: number;
  targetCpuPercent?: number;
  targetMemoryPercent?: number;
  targetRps?: number;
}

export const defaultAutoscaling: AutoscalingSettings = { enabled: false, minReplicas: 1, maxReplicas: 3, targetCpuPercent: 70 };

export class AutoscalingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function validateAutoscaling(value: any, preview: boolean): AutoscalingSettings {
  if (!value || typeof value.enabled !== 'boolean') throw new AutoscalingError('enabled must be boolean');
  if (Object.keys(value).some(key => !['enabled', 'minReplicas', 'maxReplicas', 'targetCpuPercent', 'targetMemoryPercent', 'targetRps'].includes(key))) throw new AutoscalingError('Unknown autoscaling setting');
  if (!Number.isInteger(value.minReplicas) || !Number.isInteger(value.maxReplicas) || value.minReplicas < 0 || value.maxReplicas < 1 || value.maxReplicas > 1000 || value.minReplicas > value.maxReplicas) {
    throw new AutoscalingError('Replica bounds must be integers: 0 <= minReplicas <= maxReplicas <= 1000, maxReplicas >= 1');
  }
  for (const key of ['targetCpuPercent', 'targetMemoryPercent']) {
    if (value[key] != null && (!Number.isInteger(value[key]) || value[key] < 1 || value[key] > 100)) throw new AutoscalingError(`${key} must be an integer between 1 and 100`);
  }
  if (value.targetRps != null && (!Number.isFinite(value.targetRps) || value.targetRps <= 0 || value.targetRps > 1000000)) throw new AutoscalingError('targetRps must be between 0 (exclusive) and 1000000');
  if (value.enabled && value.minReplicas === 0 && !preview) throw new AutoscalingError('Scale-to-zero is available only for previews');
  if (value.enabled && value.targetCpuPercent == null && value.targetMemoryPercent == null && value.targetRps == null && value.minReplicas !== 0) throw new AutoscalingError('Choose at least one scaling target');
  return { enabled: value.enabled, minReplicas: value.minReplicas, maxReplicas: value.maxReplicas,
    ...(value.targetCpuPercent != null ? { targetCpuPercent: value.targetCpuPercent } : {}),
    ...(value.targetMemoryPercent != null ? { targetMemoryPercent: value.targetMemoryPercent } : {}),
    ...(value.targetRps != null ? { targetRps: value.targetRps } : {}),
  };
}

export const scalingName = (name: string) => `${name.slice(0, 51).replace(/-$/, '')}-autoscaling`;
const resourceTargets = (s: AutoscalingSettings) => [
  ...s.targetCpuPercent ? [{ name: 'cpu', target: s.targetCpuPercent }] : [],
  ...s.targetMemoryPercent ? [{ name: 'memory', target: s.targetMemoryPercent }] : [],
];

export function renderHpa(namespace: string, deployment: string, settings: AutoscalingSettings) {
  return { apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
    metadata: { name: scalingName(deployment), namespace },
    spec: { scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment },
      minReplicas: settings.minReplicas, maxReplicas: settings.maxReplicas,
      metrics: resourceTargets(settings).map(r => ({ type: 'Resource', resource: { name: r.name, target: { type: 'Utilization', averageUtilization: r.target } } })),
    },
  };
}

export function renderScaledObject(namespace: string, deployment: string, settings: AutoscalingSettings, service = deployment) {
  const triggers: any[] = resourceTargets(settings).map(r => ({ type: r.name, metricType: 'Utilization', metadata: { value: String(r.target) } }));
  if (settings.targetRps != null) triggers.push({ type: 'prometheus', metadata: {
    serverAddress: 'http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090',
    query: `sum(rate(nginx_ingress_controller_requests{namespace=${JSON.stringify(namespace)},service=~${JSON.stringify(`${service}|${scalingName(deployment)}`)}}[1m])) or vector(0)`,
    threshold: String(settings.targetRps),
  } });
  if (settings.minReplicas === 0) triggers.push({ type: 'external-push', metadata: {
    scalerAddress: 'keda-add-ons-http-external-scaler.keda:9090', httpScaledObject: scalingName(deployment),
  } });
  return { apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', metadata: { name: scalingName(deployment), namespace },
    spec: { scaleTargetRef: { name: deployment }, minReplicaCount: settings.minReplicas, maxReplicaCount: settings.maxReplicas,
      cooldownPeriod: 300, pollingInterval: 15,
      advanced: { horizontalPodAutoscalerConfig: { name: scalingName(deployment) } }, triggers },
  };
}

export function renderHttpScaledObject(namespace: string, deployment: string, host: string, port: number | string, settings: AutoscalingSettings) {
  return { apiVersion: 'http.keda.sh/v1alpha1', kind: 'HTTPScaledObject',
    metadata: { name: scalingName(deployment), namespace, annotations: { 'httpscaledobject.keda.sh/skip-scaledobject-creation': 'true' } },
    spec: { hosts: [host], scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: deployment, service: deployment,
      ...(typeof port === 'number' ? { port } : { portName: port }) },
    replicas: { min: 0, max: settings.maxReplicas }, scaledownPeriod: 300,
    scalingMetric: { concurrency: { targetValue: 10 } },
    timeouts: { conditionWait: '60s', responseHeader: '30s' } },
  };
}

// Kubernetes resource quantities, including binary memory and fractional CPU.
export function quantity(value: string | number): number {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([eE][+-]?\d+|[numkKMGTPE]|[KMGTPE]i)?$/.exec(String(value));
  if (!match) throw new AutoscalingError('Cannot validate resource quantity');
  const suffix = match[2] || '';
  const factors: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  const result = Number(match[1]) * (suffix.endsWith('i') ? 1024 ** ('KMGTPE'.indexOf(suffix[0]) + 1) : /^[eE][+-]?\d+$/.test(suffix) ? 10 ** Number(suffix.slice(1)) : factors[suffix] || 1);
  if (!Number.isFinite(result) || result < 0) throw new AutoscalingError('Cannot validate resource quantity');
  return result;
}

/** Check every quota with room for other workloads, including all preview branches. */
export function validateScalingQuota(settings: AutoscalingSettings, deployments: any[], quotas: any[], currentUsage?: Record<string, number>) {
  if (!settings.enabled) return;
  const demand: Record<string, number> = { pods: 0 };
  const current: Record<string, number> = { pods: 0 };
  for (const deployment of deployments) {
    const pod = deployment.spec.template.spec;
    const containers = pod.containers || [];
    for (const resource of ['cpu', 'memory']) {
      if ((resource === 'cpu' ? settings.targetCpuPercent : settings.targetMemoryPercent) != null && containers.some((c: any) => !c.resources?.requests?.[resource])) throw new AutoscalingError(`All containers need ${resource} requests for utilization scaling`);
    }
    // Account for rolling-update surge while reserving the configured maximum.
    const surge = deployment.spec.strategy?.type === 'Recreate' ? 0 : deployment.spec.strategy?.rollingUpdate?.maxSurge ?? '25%';
    const peak = settings.maxReplicas + (String(surge).endsWith('%') ? Math.ceil(settings.maxReplicas * parseFloat(surge) / 100) : Number(surge));
    const replicas = deployment.spec.replicas ?? 1;
    demand.pods += peak;
    current.pods += replicas;
    for (const kind of ['requests', 'limits']) for (const resource of ['cpu', 'memory']) {
      const key = `${kind}.${resource}`;
      let perPod = containers.reduce((sum: number, c: any) => sum + quantity(c.resources?.[kind]?.[resource] || 0), 0);
      if (quotas.some(q => q.spec?.hard?.[key] != null) && containers.some((c: any) => !c.resources?.[kind]?.[resource])) throw new AutoscalingError(`All containers need ${key} to validate ResourceQuota`);
      // Refuse restartable init containers until their overlapping requests can be reserved.
      if (pod.initContainers?.some((c: any) => c.restartPolicy === 'Always')) throw new AutoscalingError('Autoscaling with restartable init containers is not supported');
      for (const init of pod.initContainers || []) {
        if (quotas.some(q => q.spec?.hard?.[key] != null) && !init.resources?.[kind]?.[resource]) throw new AutoscalingError(`Init containers need ${key} to validate ResourceQuota`);
        perPod = Math.max(perPod, quantity(init.resources?.[kind]?.[resource] || 0));
      }
      perPod += quantity(pod.overhead?.[resource] || 0);
      demand[key] = (demand[key] || 0) + perPod * peak;
      current[key] = (current[key] || 0) + perPod * replicas;
    }
  }
  for (const quota of quotas) {
    // Scoped quotas cannot safely be apportioned without inspecting matching pods.
    if (quota.spec?.scopes?.length || quota.spec?.scopeSelector) throw new AutoscalingError('Scoped ResourceQuota requires administrator review');
    for (const [key, required] of Object.entries(demand)) {
      const hard = quota.spec?.hard?.[key];
      if (hard == null) continue;
      const other = Math.max(0, quantity(quota.status?.used?.[key] || 0) - ((currentUsage || current)[key] || 0));
      if (required + other > quantity(hard) + 1e-9) throw new AutoscalingError(`maxReplicas exceeds ResourceQuota ${key} (including rollout surge and other workloads)`);
    }
  }
}

/** Actual admitted pods include LimitRange defaults and may differ from the Deployment's desired replicas. */
export function currentScalingUsage(deployments: any[], pods: any[]): Record<string, number> {
  const usage: Record<string, number> = { pods: 0 };
  const matches = (selector: any, labels: Record<string, string>) => {
    if (!selector || !Object.keys(selector.matchLabels || {}).length && !selector.matchExpressions?.length) return false;
    if (!Object.entries(selector.matchLabels || {}).every(([k, v]) => labels[k] === v)) return false;
    return (selector.matchExpressions || []).every((e: any) => {
      const present = Object.prototype.hasOwnProperty.call(labels, e.key);
      if (e.operator === 'Exists') return present;
      if (e.operator === 'DoesNotExist') return !present;
      if (e.operator === 'In') return present && e.values.includes(labels[e.key]);
      if (e.operator === 'NotIn') return !present || !e.values.includes(labels[e.key]);
      return false;
    });
  };
  for (const pod of pods) {
    if (['Succeeded', 'Failed'].includes(pod.status?.phase) || !deployments.some(d => matches(d.spec?.selector, pod.metadata?.labels || {}))) continue;
    usage.pods++;
    for (const kind of ['requests', 'limits']) for (const resource of ['cpu', 'memory']) {
      let amount = (pod.spec?.containers || []).reduce((n: number, c: any) => n + quantity(c.resources?.[kind]?.[resource] || 0), 0);
      for (const init of pod.spec?.initContainers || []) amount = Math.max(amount, quantity(init.resources?.[kind]?.[resource] || 0));
      const key = `${kind}.${resource}`;
      usage[key] = (usage[key] || 0) + amount + quantity(pod.spec?.overhead?.[resource] || 0);
    }
  }
  return usage;
}
