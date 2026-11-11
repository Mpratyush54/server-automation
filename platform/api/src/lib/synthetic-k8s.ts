import type { SyntheticCheck } from '../entities/SyntheticCheck';
import { referencedSecrets } from './synthetic-assertions';
import { runnerToken } from './synthetic-checks';
import { loadKubeConfig } from './kube-config';
import { resolveTarget } from './synthetic-ssrf';
import { cronSchedule } from './synthetic-cron';

/**
 * Kubernetes resources for synthetic checks (#42, full profile).
 *
 * HTTP / SSL checks → a blackbox-exporter `Probe` (prometheus-operator) in `monitoring`, so
 * Prometheus also scrapes probe_success / probe_duration_seconds /
 * probe_ssl_earliest_cert_expiry for the check. Rendered only when the full telemetry
 * backend is installed (PLATFORM_OBSERVABILITY=enabled), only for targets that resolve to
 * public addresses, and only for checks without secret headers (a Probe is readable by
 * cluster operators and cannot hold secrets). blackbox-exporter itself is confined by an
 * egress NetworkPolicy (no private ranges) installed by platformctl.
 * The API's own runner stays the source of truth for results, assertions and alerts.
 *
 * Browser checks → a CronJob in the `synthetics` namespace running the Playwright runner
 * image (platform/synthetics-runner), restricted securityContext, explicit requests/limits,
 * concurrencyPolicy Forbid, plus a per-check Secret with its runner token. The namespace has
 * a ResourceQuota (global browser concurrency) and an egress NetworkPolicy (public internet +
 * the API's runner-only port). Enabled only when platformctl wrote the `synthetics-runner`
 * ConfigMap (full profile + SYNTHETICS_BROWSER=true).
 */

export const PROBE_NAMESPACE = 'monitoring';
export const SYNTHETICS_NAMESPACE = 'synthetics';
export const CHECK_LABEL = 'platform.io/synthetic-check';
export const RUNNER_CONFIGMAP = 'synthetics-runner';
/** The API's runner-only listener (SYNTHETICS_RUNNER_PORT) behind the platform-api-synthetics Service. */
export const DEFAULT_API_URL = 'http://platform-api-synthetics.platform.svc:3001';
/** Ingress controller Service; the CoreDNS rewrite sends *.DOMAIN there as well. */
export const INGRESS_SERVICE = 'ingress-nginx-controller.ingress-nginx.svc.cluster.local';
/** ConfigMap (synthetics namespace) with the internal CA certificate, written by platformctl. */
export const PLATFORM_CA_CONFIGMAP = 'platform-ca';
export const PLATFORM_CA_MOUNT = '/etc/platform-ca';
export const BROWSER_RESOURCES = {
  requests: { cpu: '250m', memory: '512Mi', 'ephemeral-storage': '256Mi' },
  limits: { cpu: '1', memory: '1Gi', 'ephemeral-storage': '1Gi' },
};

export function probesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.PLATFORM_OBSERVABILITY || '').toLowerCase() === 'enabled' && String(env.SYNTHETICS_PROBES || '').toLowerCase() !== 'off';
}

export function resourceName(checkId: string): string {
  return `synthetic-${checkId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 63);
}

/** Whether a check can be mirrored as a blackbox Probe (no secrets, simple GET/HEAD). */
export function probeEligible(check: Pick<SyntheticCheck, 'type' | 'config' | 'enabled'>): boolean {
  if (!check.enabled) return false;
  if (check.type === 'ssl') return true;
  if (check.type !== 'http') return false;
  const c = check.config || {};
  if (c.method && !['GET', 'HEAD'].includes(String(c.method).toUpperCase())) return false;
  if (c.body) return false;
  if (Object.keys(c.headers || {}).length > 0) return false;
  if (String(c.url || '').includes('{{')) return false;
  return referencedSecrets(String(c.url || '')).length === 0;
}

export function renderProbe(check: Pick<SyntheticCheck, 'id' | 'projectId' | 'type' | 'intervalSeconds' | 'timeoutMs' | 'config'>): Record<string, any> {
  const isSsl = check.type === 'ssl';
  const target = isSsl ? `${check.config.host}:${check.config.port || 443}` : String(check.config.url);
  const interval = Math.max(60, check.intervalSeconds);
  const timeout = Math.min(Math.ceil(check.timeoutMs / 1000), 30, interval);
  return {
    apiVersion: 'monitoring.coreos.com/v1',
    kind: 'Probe',
    metadata: {
      name: resourceName(check.id),
      namespace: PROBE_NAMESPACE,
      labels: {
        release: 'kube-prometheus',
        'app.kubernetes.io/managed-by': 'platform-api',
        [CHECK_LABEL]: check.id,
        'platform.io/project': check.projectId,
      },
    },
    spec: {
      jobName: 'synthetics',
      interval: `${interval}s`,
      scrapeTimeout: `${timeout}s`,
      module: isSsl ? 'synthetic_tls' : 'synthetic_http',
      prober: { url: 'blackbox-exporter.monitoring.svc:9115', path: '/probe' },
      targets: {
        staticConfig: {
          static: [target],
          labels: { project_id: check.projectId, check_id: check.id, check_type: check.type },
        },
      },
    },
  };
}

export { cronSchedule };

export interface BrowserRuntime {
  enabled: boolean;
  image: string | null;
  apiUrl: string;
}

export function renderRunnerSecret(check: Pick<SyntheticCheck, 'id' | 'projectId'>, token: string): Record<string, any> {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: resourceName(check.id),
      namespace: SYNTHETICS_NAMESPACE,
      labels: { 'app.kubernetes.io/managed-by': 'platform-api', [CHECK_LABEL]: check.id, 'platform.io/project': check.projectId },
    },
    type: 'Opaque',
    stringData: { RUN_TOKEN: token },
  };
}

export function renderBrowserCronJob(
  check: Pick<SyntheticCheck, 'id' | 'projectId' | 'intervalSeconds' | 'timeoutMs' | 'enabled'>,
  runtime: { image: string; apiUrl: string },
): Record<string, any> {
  const name = resourceName(check.id);
  const deadline = Math.ceil(check.timeoutMs / 1000) + 90;
  const labels = { 'app.kubernetes.io/managed-by': 'platform-api', 'app.kubernetes.io/name': 'synthetics-browser', [CHECK_LABEL]: check.id, 'platform.io/project': check.projectId };
  return {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: { name, namespace: SYNTHETICS_NAMESPACE, labels },
    spec: {
      schedule: cronSchedule(check.intervalSeconds, check.id),
      // Fixed zone so the API can show the next run (synthetic-cron.ts).
      timeZone: 'Etc/UTC',
      suspend: !check.enabled,
      concurrencyPolicy: 'Forbid',
      startingDeadlineSeconds: 120,
      successfulJobsHistoryLimit: 1,
      failedJobsHistoryLimit: 1,
      jobTemplate: {
        metadata: { labels },
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: deadline,
          ttlSecondsAfterFinished: 600,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              enableServiceLinks: false,
              securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: 'RuntimeDefault' } },
              containers: [{
                name: 'runner',
                image: runtime.image,
                imagePullPolicy: 'IfNotPresent',
                env: [
                  { name: 'CHECK_ID', value: check.id },
                  { name: 'PLATFORM_API_URL', value: runtime.apiUrl },
                  { name: 'RUN_TOKEN', valueFrom: { secretKeyRef: { name, key: 'RUN_TOKEN' } } },
                  { name: 'HOME', value: '/tmp' },
                  // Project env hosts are mapped to this Service's address inside Chromium.
                  { name: 'INGRESS_SERVICE', value: INGRESS_SERVICE },
                  { name: 'PLATFORM_CA_FILE', value: `${PLATFORM_CA_MOUNT}/ca.crt` },
                ],
                resources: BROWSER_RESOURCES,
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                volumeMounts: [
                  { name: 'tmp', mountPath: '/tmp' },
                  { name: 'shm', mountPath: '/dev/shm' },
                  { name: 'platform-ca', mountPath: PLATFORM_CA_MOUNT, readOnly: true },
                ],
              }],
              volumes: [
                { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
                { name: 'shm', emptyDir: { medium: 'Memory', sizeLimit: '256Mi' } },
                // Internal CA certificate (public part; platformctl copies it). Optional:
                // installs on Let's Encrypt only need the public roots.
                { name: 'platform-ca', configMap: { name: PLATFORM_CA_CONFIGMAP, optional: true, items: [{ key: 'ca.crt', path: 'ca.crt' }] } },
              ],
            },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Apply / delete (best effort; failures are logged and retried by the reconcile job)
// ---------------------------------------------------------------------------

export interface SyntheticK8sOps {
  readRunnerConfig(): Promise<Record<string, string> | null>;
  applyProbe(probe: Record<string, any>): Promise<void>;
  deleteProbe(name: string): Promise<void>;
  listProbeNames(): Promise<string[]>;
  applyCronJob(cronJob: Record<string, any>, secret: Record<string, any>): Promise<void>;
  deleteCronJob(name: string): Promise<void>;
  listCronJobNames(): Promise<string[]>;
}

const notFound = (err: any) => (err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code) === 404;

async function upsert(get: () => Promise<any>, create: () => Promise<any>, replace: (rv: string) => Promise<any>): Promise<void> {
  let existing: any = null;
  try {
    existing = await get();
  } catch (err) {
    if (!notFound(err)) throw err;
  }
  if (!existing) await create();
  else await replace((existing.body || existing)?.metadata?.resourceVersion);
}

function kubeOps(): SyntheticK8sOps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const k8s = require('@kubernetes/client-node');
  const kc = loadKubeConfig(new k8s.KubeConfig());
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);
  const batch = kc.makeApiClient(k8s.BatchV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const probe = { group: 'monitoring.coreos.com', version: 'v1', namespace: PROBE_NAMESPACE, plural: 'probes' };
  const ignore404 = async (fn: () => Promise<any>) => { try { await fn(); } catch (err) { if (!notFound(err)) throw err; } };
  return {
    async readRunnerConfig() {
      try {
        const cm: any = await core.readNamespacedConfigMap({ name: RUNNER_CONFIGMAP, namespace: SYNTHETICS_NAMESPACE });
        return (cm.body || cm)?.data || {};
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
    },
    async applyProbe(body) {
      const name = body.metadata.name;
      await upsert(
        () => custom.getNamespacedCustomObject({ ...probe, name }),
        () => custom.createNamespacedCustomObject({ ...probe, body }),
        (rv) => custom.replaceNamespacedCustomObject({ ...probe, name, body: { ...body, metadata: { ...body.metadata, resourceVersion: rv } } }),
      );
    },
    async deleteProbe(name) { await ignore404(() => custom.deleteNamespacedCustomObject({ ...probe, name })); },
    async listProbeNames() {
      const res: any = await custom.listNamespacedCustomObject({ ...probe, labelSelector: CHECK_LABEL });
      return ((res.body || res)?.items || []).map((i: any) => i.metadata?.name).filter(Boolean);
    },
    async applyCronJob(cronJob, secret) {
      const name = cronJob.metadata.name;
      const ns = SYNTHETICS_NAMESPACE;
      await upsert(
        () => core.readNamespacedSecret({ name, namespace: ns }),
        () => core.createNamespacedSecret({ namespace: ns, body: secret }),
        (rv) => core.replaceNamespacedSecret({ name, namespace: ns, body: { ...secret, metadata: { ...secret.metadata, resourceVersion: rv } } }),
      );
      await upsert(
        () => batch.readNamespacedCronJob({ name, namespace: ns }),
        () => batch.createNamespacedCronJob({ namespace: ns, body: cronJob }),
        (rv) => batch.replaceNamespacedCronJob({ name, namespace: ns, body: { ...cronJob, metadata: { ...cronJob.metadata, resourceVersion: rv } } }),
      );
    },
    async deleteCronJob(name) {
      await ignore404(() => batch.deleteNamespacedCronJob({ name, namespace: SYNTHETICS_NAMESPACE, propagationPolicy: 'Background' }));
      await ignore404(() => core.deleteNamespacedSecret({ name, namespace: SYNTHETICS_NAMESPACE }));
    },
    async listCronJobNames() {
      const res: any = await batch.listNamespacedCronJob({ namespace: SYNTHETICS_NAMESPACE, labelSelector: CHECK_LABEL });
      return ((res.body || res)?.items || []).map((i: any) => i.metadata?.name).filter(Boolean);
    },
  };
}

let ops: SyntheticK8sOps | null = null;
function getOps(): SyntheticK8sOps {
  if (!ops) ops = kubeOps();
  return ops;
}
export function setSyntheticK8sOpsForTests(o: SyntheticK8sOps | null): void {
  ops = o;
  runtimeCache = null;
}

let runtimeCache: { at: number; value: BrowserRuntime } | null = null;

/** Browser runner availability: platformctl's ConfigMap (cached 60 s) or env overrides (dev). */
export async function browserRuntime(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<BrowserRuntime> {
  if (String(env.SYNTHETICS_BROWSER || '').toLowerCase() === 'enabled' && env.SYNTHETICS_BROWSER_IMAGE) {
    return { enabled: true, image: env.SYNTHETICS_BROWSER_IMAGE, apiUrl: env.SYNTHETICS_API_URL || DEFAULT_API_URL };
  }
  if (runtimeCache && now - runtimeCache.at < 60_000) return runtimeCache.value;
  let value: BrowserRuntime = { enabled: false, image: null, apiUrl: DEFAULT_API_URL };
  try {
    const data = await getOps().readRunnerConfig();
    if (data && data.browser === 'enabled' && data.image) {
      value = { enabled: true, image: data.image, apiUrl: data.apiUrl || DEFAULT_API_URL };
    }
  } catch {
    /* not in a cluster / no RBAC: browser checks unavailable */
  }
  runtimeCache = { at: now, value };
  return value;
}

/** Create/update/delete the check's Kubernetes resources to match its definition. Never throws. */
export async function syncCheckResources(
  check: SyntheticCheck,
  opts: { ingressHosts?: string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<{ probe: 'applied' | 'deleted' | 'skipped'; cronJob: 'applied' | 'deleted' | 'skipped'; error?: string }> {
  const env = opts.env || process.env;
  const out: { probe: 'applied' | 'deleted' | 'skipped'; cronJob: 'applied' | 'deleted' | 'skipped'; error?: string } = { probe: 'skipped', cronJob: 'skipped' };
  const name = resourceName(check.id);
  try {
    if (check.type === 'browser') {
      const rt = await browserRuntime(env);
      if (rt.enabled && rt.image) {
        await getOps().applyCronJob(renderBrowserCronJob(check, { image: rt.image, apiUrl: rt.apiUrl }), renderRunnerSecret(check, runnerToken(check.id)));
        out.cronJob = 'applied';
      }
    } else if (probesEnabled(env)) {
      let eligible = probeEligible(check);
      if (eligible) {
        // Only public targets: a target allowed via the ingress exception is not mirrored.
        try {
          const url = check.type === 'ssl' ? `https://${check.config.host}:${check.config.port || 443}/` : String(check.config.url);
          const t = await resolveTarget(url, { allowedIngressHosts: [] });
          eligible = !t.ingressException;
        } catch {
          eligible = false;
        }
      }
      if (eligible) {
        await getOps().applyProbe(renderProbe(check));
        out.probe = 'applied';
      } else {
        await getOps().deleteProbe(name);
        out.probe = 'deleted';
      }
    }
  } catch (err: any) {
    out.error = String(err?.message || err).slice(0, 300);
    console.warn(`[synthetics] syncing resources for check ${check.id} failed: ${out.error}`);
  }
  return out;
}

export async function deleteCheckResources(checkId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const name = resourceName(checkId);
  try {
    if (probesEnabled(env)) await getOps().deleteProbe(name);
    if ((await browserRuntime(env)).enabled) await getOps().deleteCronJob(name);
  } catch (err: any) {
    console.warn(`[synthetics] deleting resources for check ${checkId} failed: ${err?.message || err}`);
  }
}

/** Leader job: apply current checks, delete Probes/CronJobs whose check no longer exists. */
export async function reconcileSyntheticResources(checks: SyntheticCheck[], env: NodeJS.ProcessEnv = process.env): Promise<{ applied: number; deleted: number }> {
  let applied = 0;
  let deleted = 0;
  const wanted = new Set(checks.map((c) => resourceName(c.id)));
  for (const c of checks) {
    const r = await syncCheckResources(c, { env });
    if (r.probe === 'applied' || r.cronJob === 'applied') applied++;
  }
  try {
    if (probesEnabled(env)) {
      for (const n of await getOps().listProbeNames()) if (!wanted.has(n)) { await getOps().deleteProbe(n); deleted++; }
    }
    if ((await browserRuntime(env)).enabled) {
      const browserWanted = new Set(checks.filter((c) => c.type === 'browser').map((c) => resourceName(c.id)));
      for (const n of await getOps().listCronJobNames()) if (!browserWanted.has(n)) { await getOps().deleteCronJob(n); deleted++; }
    }
  } catch (err: any) {
    console.warn(`[synthetics] reconcile cleanup failed: ${err?.message || err}`);
  }
  return { applied, deleted };
}
