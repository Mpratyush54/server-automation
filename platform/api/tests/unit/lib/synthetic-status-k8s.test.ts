import { buildStatusFeed, overallStatus } from '../../../src/lib/synthetic-status';
import {
  BROWSER_RESOURCES, cronSchedule, probeEligible, reconcileSyntheticResources, renderBrowserCronJob, renderProbe,
  platformCaCertificate, resourceName, setSyntheticK8sOpsForTests, SyntheticK8sOps, syncCheckResources,
} from '../../../src/lib/synthetic-k8s';
import { runnerToken, verifyRunnerToken } from '../../../src/lib/synthetic-checks';

const ID = '11111111-2222-4333-8444-555555555555';
const PROJ = '99999999-2222-4333-8444-555555555555';

describe('status feed (#46 contract)', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const checks: any[] = [
    { id: 'c1', name: 'API health', type: 'http', enabled: true, lastStatus: 'up', lastRunAt: new Date('2026-11-10T11:59:00Z'),
      config: { url: 'https://internal-looking.example.com/secret-path', headers: { Authorization: '{{secret.T}}' }, statusPage: { visible: true, name: 'API' } } },
    { id: 'c2', name: 'Checkout', type: 'browser', enabled: true, lastStatus: 'down', lastRunAt: now, config: { steps: [{ action: 'goto', url: 'https://shop.example.com' }] } },
    { id: 'c3', name: 'Hidden', type: 'ssl', enabled: true, lastStatus: 'up', lastRunAt: now, config: { host: 'x', statusPage: { visible: false } } },
  ];
  const daily = [
    { checkId: 'c1', day: '2026-11-10', total: 100, failed: 0, avgLatencyMs: 50 },
    { checkId: 'c1', day: '2026-11-09', total: 100, failed: 2, avgLatencyMs: 60 },
    { checkId: 'c2', day: '2026-11-10', total: 10, failed: 5, avgLatencyMs: 900 },
    { checkId: 'c1', day: '2026-10-01', total: 100, failed: 100, avgLatencyMs: 1 }, // outside the window
  ];
  const h24 = [{ checkId: 'c1', day: null, total: 120, failed: 1, avgLatencyMs: 55.4 }];

  it('aggregates per component with no internal details', () => {
    const feed = buildStatusFeed(PROJ, checks, daily, h24, now);
    expect(feed).toMatchObject({ projectId: PROJ, generatedAt: now.toISOString(), status: 'partial_outage' });
    expect(feed.components.map((c) => c.id)).toEqual(['c1', 'c2']);
    const api = feed.components[0];
    expect(api).toMatchObject({
      id: 'c1', name: 'API', type: 'http', status: 'operational', lastCheckedAt: '2026-11-10T11:59:00.000Z',
      uptime: { '24h': 99.167, '7d': 99, '30d': 99 }, avgLatencyMs24h: 55,
    });
    expect(api.days).toHaveLength(30);
    expect(api.days[29]).toEqual({ date: '2026-11-10', uptime: 100, status: 'operational' });
    expect(api.days[28]).toEqual({ date: '2026-11-09', uptime: 98, status: 'degraded' });
    expect(api.days[0]).toEqual({ date: '2026-10-12', uptime: null, status: 'unknown' });
    expect(feed.components[1]).toMatchObject({ status: 'outage', uptime: { '24h': null } });
    expect(Object.keys(api).sort()).toEqual(['avgLatencyMs24h', 'days', 'id', 'lastCheckedAt', 'name', 'status', 'type', 'uptime']);
    const text = JSON.stringify(feed);
    for (const leak of ['internal-looking', 'secret-path', 'Authorization', 'shop.example.com', 'Hidden', 'steps']) expect(text).not.toContain(leak);
  });

  it('overall status', () => {
    expect(overallStatus([])).toBe('unknown');
    expect(overallStatus([{ status: 'operational' }, { status: 'unknown' }])).toBe('operational');
    expect(overallStatus([{ status: 'operational' }, { status: 'degraded' }])).toBe('degraded');
    expect(overallStatus([{ status: 'outage' }, { status: 'operational' }])).toBe('partial_outage');
    expect(overallStatus([{ status: 'outage' }])).toBe('major_outage');
  });
});

describe('blackbox Probe rendering', () => {
  it('HTTP check → Probe with the synthetic_http module and check labels', () => {
    const p = renderProbe({ id: ID, projectId: PROJ, type: 'http', intervalSeconds: 300, timeoutMs: 10_000, config: { url: 'https://example.com/' } });
    expect(p).toMatchObject({
      apiVersion: 'monitoring.coreos.com/v1', kind: 'Probe',
      metadata: { name: `synthetic-${ID}`, namespace: 'monitoring', labels: { release: 'kube-prometheus', 'platform.io/synthetic-check': ID, 'platform.io/project': PROJ } },
      spec: {
        jobName: 'synthetics', interval: '300s', scrapeTimeout: '10s', module: 'synthetic_http',
        prober: { url: 'blackbox-exporter.monitoring.svc:9115', path: '/probe' },
        targets: { staticConfig: { static: ['https://example.com/'], labels: { project_id: PROJ, check_id: ID, check_type: 'http' } } },
      },
    });
  });

  it('SSL check → synthetic_tls module on host:port', () => {
    const p = renderProbe({ id: ID, projectId: PROJ, type: 'ssl', intervalSeconds: 3600, timeoutMs: 60_000, config: { host: 'example.com', port: 8443 } });
    expect(p.spec).toMatchObject({ module: 'synthetic_tls', scrapeTimeout: '30s', targets: { staticConfig: { static: ['example.com:8443'] } } });
  });

  it('only simple, secret-free checks are mirrored', () => {
    const base = { type: 'http' as const, enabled: true };
    expect(probeEligible({ ...base, config: { url: 'https://e.com/', method: 'GET' } })).toBe(true);
    expect(probeEligible({ ...base, config: { url: 'https://e.com/', method: 'POST' } })).toBe(false);
    expect(probeEligible({ ...base, config: { url: 'https://e.com/', headers: { Authorization: '{{secret.T}}' } } })).toBe(false);
    expect(probeEligible({ ...base, config: { url: 'https://e.com/?k={{secret.T}}' } })).toBe(false);
    expect(probeEligible({ ...base, enabled: false, config: { url: 'https://e.com/' } })).toBe(false);
    expect(probeEligible({ type: 'multistep', enabled: true, config: {} })).toBe(false);
    expect(probeEligible({ type: 'ssl', enabled: true, config: { host: 'e.com' } })).toBe(true);
  });
});

describe('browser CronJob rendering', () => {
  const cj = renderBrowserCronJob({ id: ID, projectId: PROJ, intervalSeconds: 900, timeoutMs: 60_000, enabled: true }, { image: 'ghcr.io/example/platform-synthetics-runner:1.0.0', apiUrl: 'http://platform-api-synthetics.platform.svc:3001' });
  const pod = cj.spec.jobTemplate.spec.template.spec;
  const c = pod.containers[0];

  it('is resource-limited, non-overlapping and short-lived', () => {
    expect(cj.metadata).toMatchObject({ name: resourceName(ID), namespace: 'synthetics' });
    expect(cj.spec).toMatchObject({ concurrencyPolicy: 'Forbid', suspend: false, successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1 });
    expect(cj.spec.jobTemplate.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 150, ttlSecondsAfterFinished: 600 });
    expect(c.resources).toEqual(BROWSER_RESOURCES);
    expect(c.resources.limits).toMatchObject({ cpu: '1', memory: '1Gi' });
  });

  it('passes Pod Security "restricted" and has no Kubernetes credentials', () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
    expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(pod.volumes.some((v: any) => v.hostPath)).toBe(false);
    // The run token comes from the per-check Secret, never inline.
    expect(c.env.find((e: any) => e.name === 'RUN_TOKEN')).toEqual({ name: 'RUN_TOKEN', valueFrom: { secretKeyRef: { name: resourceName(ID), key: 'RUN_TOKEN' } } });
    expect(JSON.stringify(cj)).not.toContain('synr_');
  });

  it('mounts the internal CA (optional, read-only) and names the ingress Service for env hosts', () => {
    expect(c.env).toEqual(expect.arrayContaining([
      { name: 'INGRESS_SERVICE', value: 'ingress-nginx-controller.ingress-nginx.svc.cluster.local' },
      { name: 'PLATFORM_CA_FILE', value: '/etc/platform-ca/ca.crt' },
    ]));
    expect(c.volumeMounts).toContainEqual({ name: 'platform-ca', mountPath: '/etc/platform-ca', readOnly: true });
    expect(pod.volumes).toContainEqual({ name: 'platform-ca', configMap: { name: 'platform-ca', optional: true, items: [{ key: 'ca.crt', path: 'ca.crt' }] } });
    expect(pod.volumes.some((v: any) => v.secret)).toBe(false);
  });

  it('cron schedules spread checks and respect the interval', () => {
    expect(cronSchedule(300, ID)).toMatch(/^(\d+,){11}\d+ \* \* \* \*$/);
    const every15 = cronSchedule(900, ID).split(' ')[0].split(',').map(Number);
    expect(every15).toHaveLength(4);
    expect(every15[1] - every15[0]).toBe(15);
    expect(cronSchedule(3600, ID)).toMatch(/^\d+ \d+-23\/1 \* \* \*$/);
    expect(cronSchedule(7200, ID)).toMatch(/^\d+ [01]-23\/2 \* \* \*$/);
    expect(cronSchedule(86400, ID)).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});

describe('resource sync', () => {
  function fakeOps(runnerCfg: Record<string, string> | null = null, ca: string | null = null) {
    const calls: string[] = [];
    const ops: SyntheticK8sOps = {
      readRunnerConfig: async () => runnerCfg,
      readPlatformCa: async () => { calls.push('ca'); return ca; },
      applyProbe: async (p) => { calls.push(`probe:${p.metadata.name}`); },
      deleteProbe: async (n) => { calls.push(`-probe:${n}`); },
      listProbeNames: async () => ['synthetic-orphan', resourceName(ID)],
      applyCronJob: async (cj, secret) => { calls.push(`cron:${cj.metadata.name}`); calls.push(`secret:${secret.stringData.RUN_TOKEN === runnerToken(ID) ? 'ok' : 'bad'}`); },
      deleteCronJob: async (n) => { calls.push(`-cron:${n}`); },
      listCronJobNames: async () => ['synthetic-old'],
    };
    setSyntheticK8sOpsForTests(ops);
    return calls;
  }
  beforeAll(() => { process.env.SECRETS_ENCRYPTION_KEY = 'k'.repeat(64); });
  afterEach(() => setSyntheticK8sOpsForTests(null));

  const http = { id: ID, projectId: PROJ, type: 'http', enabled: true, intervalSeconds: 300, timeoutMs: 5000, config: { url: 'https://93.184.216.34/' } } as any;

  it('no Probes outside the full profile', async () => {
    const calls = fakeOps();
    expect(await syncCheckResources(http, { env: {} })).toMatchObject({ probe: 'skipped' });
    expect(calls).toEqual([]);
  });

  it('full profile: applies a Probe for a public target, deletes it for a private one', async () => {
    const calls = fakeOps();
    const env = { PLATFORM_OBSERVABILITY: 'enabled' };
    expect(await syncCheckResources(http, { env })).toMatchObject({ probe: 'applied' });
    expect(await syncCheckResources({ ...http, config: { url: 'https://10.0.0.1/' } }, { env })).toMatchObject({ probe: 'deleted' });
    expect(calls).toEqual([`probe:${resourceName(ID)}`, `-probe:${resourceName(ID)}`]);
  });

  it('platform hosts (DOMAIN / *.DOMAIN) are never mirrored as Probes (#152)', async () => {
    const calls = fakeOps();
    const env = { PLATFORM_OBSERVABILITY: 'enabled', DOMAIN: 'apps.example.com' };
    for (const url of ['https://apps.example.com/', 'https://api.apps.example.com/api/health']) {
      expect(await syncCheckResources({ ...http, config: { url } }, { env })).toMatchObject({ probe: 'deleted' });
    }
    expect(await syncCheckResources({ ...http, type: 'ssl', config: { host: 'api.apps.example.com' } }, { env })).toMatchObject({ probe: 'deleted' });
    expect(calls.every((c) => c.startsWith('-probe:'))).toBe(true);
  });

  it('platform CA: read from the synthetics/platform-ca copy only with a DOMAIN, cached', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
    const calls = fakeOps(null, pem);
    expect(await platformCaCertificate({}, 1_000)).toBeNull();
    expect(calls).toEqual([]);
    expect(await platformCaCertificate({ DOMAIN: 'apps.example.com' }, 1_000)).toBe(pem);
    expect(await platformCaCertificate({ DOMAIN: 'apps.example.com' }, 2_000)).toBe(pem);
    expect(calls).toEqual(['ca']);
    // No RBAC / API error: null, never a throw.
    setSyntheticK8sOpsForTests({ readRunnerConfig: async () => null, readPlatformCa: async () => { throw new Error('forbidden'); } } as any);
    expect(await platformCaCertificate({ DOMAIN: 'apps.example.com' }, 1_000)).toBeNull();
  });

  it('browser checks get a CronJob + token Secret only when the runner is enabled', async () => {
    const browser = { ...http, type: 'browser', intervalSeconds: 900, timeoutMs: 60_000, config: { steps: [] } };
    let calls = fakeOps(null);
    expect(await syncCheckResources(browser, { env: {} })).toMatchObject({ cronJob: 'skipped' });
    expect(calls).toEqual([]);
    calls = fakeOps({ browser: 'enabled', image: 'ghcr.io/example/runner:1' });
    expect(await syncCheckResources(browser, { env: {} })).toMatchObject({ cronJob: 'applied' });
    expect(calls).toEqual([`cron:${resourceName(ID)}`, 'secret:ok']);
  });

  it('reconcile removes orphaned Probes and CronJobs', async () => {
    const calls = fakeOps({ browser: 'enabled', image: 'img' });
    await reconcileSyntheticResources([http], { PLATFORM_OBSERVABILITY: 'enabled' });
    expect(calls).toEqual([`probe:${resourceName(ID)}`, '-probe:synthetic-orphan', '-cron:synthetic-old']);
  });
});

describe('runner tokens', () => {
  it('are per check and verified in constant time', () => {
    const key = 'k'.repeat(64);
    const t = runnerToken(ID, key);
    expect(t).toMatch(/^synr_/);
    expect(verifyRunnerToken(ID, t, key)).toBe(true);
    expect(verifyRunnerToken(PROJ, t, key)).toBe(false);
    expect(verifyRunnerToken(ID, t.slice(0, -1), key)).toBe(false);
    expect(verifyRunnerToken(ID, t, 'other-key')).toBe(false);
  });
});

describe('runner job diagnosis', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { describeJobFailure } = require('../../../src/lib/synthetic-k8s');
  const pod = (state: any, extra: any = {}) => ({ status: { containerStatuses: [{ name: 'runner', state }], ...extra } });

  it('explains image pull failures, OOM kills, exit codes, scheduling and job deadlines', () => {
    expect(describeJobFailure({}, [pod({ waiting: { reason: 'ImagePullBackOff', message: 'secret-ish detail' } })])).toBe('runner pod: ImagePullBackOff');
    expect(describeJobFailure({}, [pod({ terminated: { reason: 'OOMKilled', exitCode: 137 } })])).toBe('runner pod: OOMKilled (memory limit)');
    expect(describeJobFailure({}, [pod({ terminated: { reason: 'Error', exitCode: 1 } })])).toBe('runner exited with code 1 (Error)');
    expect(describeJobFailure({}, [{ status: { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] } }])).toBe('runner pod not scheduled: Unschedulable');
    expect(describeJobFailure({ status: { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded', message: 'Job was active longer than specified deadline' }] } }, []))
      .toBe('runner job failed: DeadlineExceeded - Job was active longer than specified deadline');
    expect(describeJobFailure({ status: { conditions: [{ type: 'Complete', status: 'True' }] } }, [pod({ terminated: { reason: 'Completed', exitCode: 0 } })])).toBeNull();
  });
});
