import { currentScalingUsage, defaultAutoscaling, quantity, renderHpa, renderHttpScaledObject, renderScaledObject, validateAutoscaling, validateScalingQuota } from '../../../src/lib/autoscaling';

const settings = { ...defaultAutoscaling, enabled: true, targetMemoryPercent: 80 };
const deployment = () => ({ spec: { replicas: 1, template: { spec: { containers: [{ resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } } }] } } } });
const quota = (hard: any, used: any = {}) => [{ spec: { hard }, status: { used } }];

describe('autoscaling settings', () => {
  it.each([
    { minReplicas: 4 }, { minReplicas: -1 }, { minReplicas: 1.5 }, { maxReplicas: 0 }, { maxReplicas: 1001 },
    { enabled: 'true' }, { targetCpuPercent: 0 }, { targetMemoryPercent: 101 }, { targetRps: -1 }, { targetRps: '2' }, { targetRps: Infinity }, { extra: true },
  ])('rejects invalid settings %j', change => {
    expect(() => validateAutoscaling({ ...settings, ...change }, true)).toThrow();
  });
  it('requires a target and restricts zero to previews', () => {
    expect(() => validateAutoscaling({ enabled: true, minReplicas: 1, maxReplicas: 3 }, false)).toThrow(/target/);
    expect(() => validateAutoscaling({ ...settings, minReplicas: 0 }, false)).toThrow(/previews/);
    expect(validateAutoscaling({ enabled: true, minReplicas: 0, maxReplicas: 1 }, true).minReplicas).toBe(0);
  });
  it('normalizes cleared optional targets', () => {
    expect(validateAutoscaling({ ...settings, targetMemoryPercent: null }, false)).not.toHaveProperty('targetMemoryPercent');
  });
});

describe('autoscaling manifests', () => {
  it('renders autoscaling/v2 utilization metrics and Deployment target', () => {
    const hpa = renderHpa('project-production', 'web', settings);
    expect(hpa.apiVersion).toBe('autoscaling/v2');
    expect(hpa.spec).toEqual({ scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'web' }, minReplicas: 1, maxReplicas: 3,
      metrics: [
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 70 } } },
        { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: 80 } } },
      ],
    });
  });
  it('combines RPS and resource metrics in one KEDA controller', () => {
    const so = renderScaledObject('project-production', 'web', { ...settings, targetRps: 25 });
    expect(so.spec.triggers.map(t => t.type)).toEqual(['cpu', 'memory', 'prometheus']);
    expect(so.spec.triggers[2].metadata).toEqual({ serverAddress: 'http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090',
      query: 'sum(rate(nginx_ingress_controller_requests{namespace="project-production",service=~"web|web-autoscaling"}[1m])) or vector(0)', threshold: '25' });
    expect(so.spec.advanced.horizontalPodAutoscalerConfig.name).toBe('web-autoscaling');
  });
  it('uses an HTTP push trigger for wake-up and prevents a second controller', () => {
    const zero = { ...settings, minReplicas: 0 };
    const http = renderHttpScaledObject('project-preview', 'web', 'web.example.org', 80, zero);
    expect(http.metadata.annotations['httpscaledobject.keda.sh/skip-scaledobject-creation']).toBe('true');
    expect(http.spec.scaleTargetRef).toEqual({ apiVersion: 'apps/v1', kind: 'Deployment', name: 'web', service: 'web', port: 80 });
    expect(http.spec.timeouts).toEqual({ conditionWait: '60s', responseHeader: '30s' });
    expect(renderScaledObject('project-preview', 'web', zero).spec.triggers).toContainEqual({ type: 'external-push', metadata: { scalerAddress: 'keda-add-ons-http-external-scaler.keda:9090', httpScaledObject: 'web-autoscaling' } });
    expect(renderHttpScaledObject('project-preview', 'web', 'web.example.org', 'http', zero).spec.scaleTargetRef).toHaveProperty('portName', 'http');
  });
});

describe('resource quota reservation', () => {
  it('allows the maximum plus rollout surge when all quotas fit', () => {
    expect(() => validateScalingQuota(settings, [deployment()], quota({ pods: '4', 'requests.cpu': '400m', 'limits.memory': '2Gi' }))).not.toThrow();
  });
  it.each([{ pods: '3' }, { 'requests.cpu': '399m' }, { 'limits.memory': '2047Mi' }])('rejects insufficient quota %j', hard => {
    expect(() => validateScalingQuota(settings, [deployment()], quota(hard))).toThrow(/ResourceQuota/);
  });
  it('reserves other workloads and all preview branches', () => {
    expect(() => validateScalingQuota(settings, [deployment()], quota({ pods: '5' }, { pods: '3' }))).toThrow(/pods/);
    expect(() => validateScalingQuota(settings, [deployment(), deployment()], quota({ pods: '7' }))).toThrow(/pods/);
  });
  it('checks every quota and refuses missing resource requests', () => {
    expect(() => validateScalingQuota(settings, [deployment()], [...quota({ pods: '10' }), ...quota({ pods: '2' })])).toThrow(/pods/);
    const d = deployment(); delete d.spec.template.spec.containers[0].resources.requests.cpu;
    expect(() => validateScalingQuota(settings, [d], [])).toThrow(/cpu requests/);
    expect(() => validateScalingQuota({ ...settings, enabled: false }, [d], [])).not.toThrow();
  });
  it('includes init containers and pod overhead', () => {
    const d: any = deployment();
    d.spec.template.spec.initContainers = [{ resources: { requests: { cpu: '1' } } }];
    d.spec.template.spec.overhead = { cpu: '10m' };
    expect(() => validateScalingQuota(settings, [d], quota({ 'requests.cpu': '4' }))).toThrow(/requests.cpu/);
  });
  it('supports Recreate without a surge reservation', () => {
    const d: any = deployment(); d.spec.strategy = { type: 'Recreate' };
    expect(() => validateScalingQuota(settings, [d], quota({ pods: '3' }))).not.toThrow();
  });
  it('handles Kubernetes quantities and rejects malformed values', () => {
    expect(quantity('1Gi')).toBe(quantity('1024Mi'));
    expect(quantity('100m')).toBe(0.1);
    expect(quantity('1e3')).toBe(1000);
    expect(() => quantity('invalid')).toThrow();
  });
  it('uses admitted pods, not desired replicas, to subtract the workload from quota usage', () => {
    const d: any = deployment();
    d.spec.selector = { matchLabels: { app: 'web' }, matchExpressions: [{ key: 'track', operator: 'In', values: ['stable'] }] };
    const pod = (labels: any, phase = 'Running') => ({ metadata: { labels }, spec: d.spec.template.spec, status: { phase } });
    const pods = [pod({ app: 'web', track: 'stable' }), pod({ app: 'web', track: 'canary' }), pod({ app: 'worker' }), pod({ app: 'web', track: 'stable' }, 'Succeeded')];
    const usage = currentScalingUsage([d], pods);
    expect(usage.pods).toBe(1);
    expect(usage['requests.cpu']).toBe(0.1);
    // Desired replicas can exceed admitted pods; do not subtract hypothetical resource use.
    d.spec.replicas = 3;
    expect(() => validateScalingQuota(settings, [d], quota({ pods: '5' }, { pods: '3' }), usage)).toThrow(/pods/);
  });
});
