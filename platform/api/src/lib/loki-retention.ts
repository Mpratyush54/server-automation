/**
 * Per-project logs retention (#47) applied through Loki runtime overrides.
 *
 * Loki runs single-tenant (auth_enabled: false -> tenant `fake`) and re-reads its runtime
 * config file (ConfigMap `loki-runtime`, key `runtime-config.yaml`, rendered by the Helm
 * chart) every few seconds. For each project with a logs override this writes two
 * `retention_stream` rules under `overrides.fake`, one per label that carries the project id:
 *   - `platform_project_id` - OTLP / pod logs shipped by Alloy
 *   - `project_id`          - SDK queue logs forwarded by the API (lib/lokilog)
 * Streams without a rule keep the global `retention_period` (TELEMETRY_RETENTION_DAYS).
 * Loki's compactor applies the periods (retention_enabled: true).
 *
 * Only the tenant's `retention_stream` list is managed; other keys in the file are kept.
 * A `helm upgrade` of Loki resets the ConfigMap; the leader job re-applies it within
 * LOKI_RETENTION_RECONCILE_MS. Full profile only (PLATFORM_OBSERVABILITY=enabled).
 * RBAC: get/update on that one ConfigMap (platformctl alerting-rbac.yaml).
 */
import type * as K8s from '@kubernetes/client-node';
import YAML from 'yaml';
import { getDb } from '../config/database';
import { registerLeaderJob } from './scheduler';

export const LOKI_RETENTION_JOB = 'loki-retention-reconcile';
export const LOKI_RUNTIME_KEY = 'runtime-config.yaml';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bound the rule list (two rules per project). */
const MAX_PROJECTS = 1000;

export const lokiRetentionSettings = (env: NodeJS.ProcessEnv = process.env) => ({
  enabled: String(env.PLATFORM_OBSERVABILITY || '').toLowerCase() === 'enabled' && env.LOKI_RETENTION_OVERRIDES !== 'disabled',
  namespace: env.LOKI_NAMESPACE || 'monitoring',
  configMap: env.LOKI_RUNTIME_CONFIGMAP || 'loki-runtime',
  tenant: env.LOKI_TENANT || 'fake',
  intervalMs: Math.max(60_000, Number(env.LOKI_RETENTION_RECONCILE_MS) || 10 * 60_000),
});

export interface ProjectLogsRetention { projectId: string; days: number }

export function retentionStreamRules(list: ProjectLogsRetention[]) {
  const rules: { selector: string; priority: number; period: string }[] = [];
  const sorted = [...list]
    .filter((p) => UUID.test(p.projectId) && Number.isInteger(p.days) && p.days >= 1 && p.days <= 365)
    .map((p) => ({ projectId: p.projectId.toLowerCase(), days: p.days }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
    .slice(0, MAX_PROJECTS);
  for (const p of sorted) {
    for (const label of ['platform_project_id', 'project_id']) {
      rules.push({ selector: `{${label}="${p.projectId}"}`, priority: 1, period: `${p.days * 24}h` });
    }
  }
  return rules;
}

/**
 * Merge the managed rules into an existing runtime config document. Returns the new YAML
 * text, or null when nothing changes.
 */
export function renderRuntimeConfig(existing: string | undefined, list: ProjectLogsRetention[], tenant = 'fake'): string | null {
  let doc: Record<string, any> = {};
  if (existing && existing.trim()) {
    const parsed = YAML.parse(existing);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed;
  }
  const rules = retentionStreamRules(list);
  const overrides: Record<string, any> = doc.overrides && typeof doc.overrides === 'object' ? { ...doc.overrides } : {};
  const tenantCfg: Record<string, any> = overrides[tenant] && typeof overrides[tenant] === 'object' ? { ...overrides[tenant] } : {};
  if (JSON.stringify(tenantCfg.retention_stream || []) === JSON.stringify(rules)) return null;
  if (rules.length) tenantCfg.retention_stream = rules;
  else delete tenantCfg.retention_stream;
  if (Object.keys(tenantCfg).length) overrides[tenant] = tenantCfg;
  else delete overrides[tenant];
  const next = { ...doc };
  if (Object.keys(overrides).length) next.overrides = overrides;
  else delete next.overrides;
  return Object.keys(next).length ? YAML.stringify(next) : '{}\n';
}

export interface RuntimeConfigMapClient {
  /** Current runtime config text, or null when the ConfigMap does not exist. */
  read(): Promise<{ text: string | undefined; resourceVersion?: string } | null>;
  write(text: string, resourceVersion?: string): Promise<void>;
}

function statusOf(err: any): number {
  return Number(err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code ?? 0);
}

let core: Promise<K8s.CoreV1Api> | null = null;
function coreApi(): Promise<K8s.CoreV1Api> {
  if (!core) {
    core = (async () => {
      const k8s = await import('@kubernetes/client-node');
      const { loadKubeConfig } = await import('./kube-config');
      const kc = new k8s.KubeConfig();
      loadKubeConfig(kc);
      return kc.makeApiClient(k8s.CoreV1Api);
    })();
    core.catch(() => { core = null; });
  }
  return core;
}

export function kubeRuntimeConfigMap(settings = lokiRetentionSettings()): RuntimeConfigMapClient {
  const { namespace, configMap: name } = settings;
  const read = async () => {
    const api = await coreApi();
    try {
      const r: any = await api.readNamespacedConfigMap({ name, namespace });
      return r?.body || r;
    } catch (err) {
      if (statusOf(err) === 404) return null;
      throw err;
    }
  };
  return {
    async read() {
      const cm = await read();
      return cm ? { text: cm.data?.[LOKI_RUNTIME_KEY], resourceVersion: cm.metadata?.resourceVersion } : null;
    },
    async write(text, resourceVersion) {
      const api = await coreApi();
      const cm = await read();
      if (!cm) throw new Error(`ConfigMap ${namespace}/${name} not found`);
      // Optimistic concurrency: replace fails with 409 if it changed since our read.
      if (resourceVersion) cm.metadata = { ...(cm.metadata || {}), resourceVersion };
      cm.data = { ...(cm.data || {}), [LOKI_RUNTIME_KEY]: text };
      await api.replaceNamespacedConfigMap({ name, namespace, body: cm });
    },
  };
}

/** Projects with an explicit logs override (telemetry_privacy_settings.retention_days.logs). */
export async function loadLogsOverrides(): Promise<ProjectLogsRetention[]> {
  const ds = await getDb();
  const rows: { project_id: string; days: string }[] = await ds.query(
    `SELECT project_id, retention_days->>'logs' AS days FROM telemetry_privacy_settings
      WHERE jsonb_typeof(retention_days->'logs') = 'number'`,
  );
  return rows.map((r) => ({ projectId: String(r.project_id), days: Math.floor(Number(r.days)) }));
}

export type ReconcileResult = 'disabled' | 'missing' | 'unchanged' | 'updated';

export async function reconcileLokiRetention(
  client: RuntimeConfigMapClient = kubeRuntimeConfigMap(),
  load: () => Promise<ProjectLogsRetention[]> = loadLogsOverrides,
  settings = lokiRetentionSettings(),
): Promise<ReconcileResult> {
  if (!settings.enabled) return 'disabled';
  const current = await client.read();
  if (!current) return 'missing'; // Loki not installed (or not the bundled chart)
  const next = renderRuntimeConfig(current.text, await load(), settings.tenant);
  if (next === null) return 'unchanged';
  await client.write(next, current.resourceVersion);
  return 'updated';
}

/** After a retention change: apply now on this replica (best effort; the job retries). */
export function requestLokiRetentionReconcile(): void {
  if (!lokiRetentionSettings().enabled) return;
  reconcileLokiRetention().catch((err: any) => {
    console.warn(`[loki-retention] reconcile failed (will retry): ${err?.message || err}`);
  });
}

let warnAt = 0;
export function startLokiRetentionReconcile(): void {
  const settings = lokiRetentionSettings();
  if (!settings.enabled) return;
  registerLeaderJob({
    name: LOKI_RETENTION_JOB,
    intervalMs: settings.intervalMs,
    initialDelayMs: 30_000,
    run: async () => {
      try {
        await reconcileLokiRetention();
      } catch (err: any) {
        if (Date.now() - warnAt > 30 * 60_000) {
          warnAt = Date.now();
          console.warn(`[loki-retention] reconcile failed: ${err?.message || err}`);
        }
        return 'skipped';
      }
    },
  });
}
