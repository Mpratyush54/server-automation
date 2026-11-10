/**
 * Full-profile integration (#43, ALERTING_MODE=ruler):
 *  - PrometheusRule `platform-alerts-<project>` in the monitoring namespace with the
 *    project's monitors and SLO recording/burn-rate rules (label release=kube-prometheus,
 *    picked up by the kube-prometheus-stack ruleSelector).
 *  - AlertmanagerConfig of the same name: route `project=<id>` -> webhook receiver = the
 *    platform API, bearer token from Secret `platform-alerting-webhook` (derived from
 *    SECRETS_ENCRYPTION_KEY, so every replica agrees without a new secret).
 *  - Loki ruler rule group for log monitors (only with ALERTING_LOKI_RULER=enabled).
 *  - Silences mirrored to the Alertmanager v2 API (project matcher always enforced).
 *
 * RBAC for this lives in platformctl's alerting-rbac.yaml (full profile only).
 */
import crypto from 'crypto';
import axios from 'axios';
import type * as K8s from '@kubernetes/client-node';
import { getDb } from '../config/database';
import { AlertMonitor } from '../entities/AlertMonitor';
import { AlertSlo } from '../entities/AlertSlo';
import { AlertSilence } from '../entities/AlertSilence';
import { alertingMode, alertingSettings, alertingUrls, lokiRulerEnabled } from './alerting-config';
import { prometheusRuleName, renderAlertmanagerConfig, renderLokiRuleGroup, renderPrometheusRule } from './alerting-rules';
import { projectNamespaces } from './alerting-evaluator';

export const WEBHOOK_TOKEN_SECRET = 'platform-alerting-webhook';
const MANAGED = 'app.kubernetes.io/managed-by=platform-api';

export function alertmanagerWebhookToken(): string {
  const base = process.env.SECRETS_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
  if (!base) throw new Error('SECRETS_ENCRYPTION_KEY not configured');
  return crypto.createHmac('sha256', base).update('platform-alertmanager-webhook-v1').digest('hex');
}

/** Constant-time check of `Authorization: Bearer <token>` from Alertmanager. */
export function verifyAlertmanagerToken(header: string | undefined): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return false;
  let expected: string;
  try { expected = alertmanagerWebhookToken(); } catch { return false; }
  const a = Buffer.from(expected);
  const b = Buffer.from(m[1].trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface CustomObjects {
  get(plural: string, version: string, name: string): Promise<any | null>;
  list(plural: string, version: string, labelSelector: string): Promise<any[]>;
  upsert(plural: string, version: string, body: any): Promise<void>;
  remove(plural: string, version: string, name: string): Promise<void>;
  ensureSecret(name: string, data: Record<string, string>): Promise<void>;
}

const GROUP = 'monitoring.coreos.com';

function status(err: any): number {
  return Number(err?.code ?? err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code ?? 0);
}

let clients: Promise<{ api: K8s.CustomObjectsApi; core: K8s.CoreV1Api }> | null = null;

/** Loaded lazily: the client is ESM and only needed in ruler mode. */
function kubeClients() {
  if (!clients) {
    clients = (async () => {
      const k8s = await import('@kubernetes/client-node');
      const { loadKubeConfig } = await import('./kube-config');
      const kc = new k8s.KubeConfig();
      loadKubeConfig(kc);
      return { api: kc.makeApiClient(k8s.CustomObjectsApi), core: kc.makeApiClient(k8s.CoreV1Api) };
    })();
    clients.catch(() => { clients = null; });
  }
  return clients;
}

export function kubeCustomObjects(namespace = alertingSettings().namespace): CustomObjects {
  const get = async (plural: string, version: string, name: string) => {
    const { api } = await kubeClients();
    try {
      const r: any = await api.getNamespacedCustomObject({ group: GROUP, version, namespace, plural, name });
      return r?.body || r;
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  };
  return {
    get,
    async list(plural, version, labelSelector) {
      const { api } = await kubeClients();
      const r: any = await api.listNamespacedCustomObject({ group: GROUP, version, namespace, plural, labelSelector });
      return (r?.body || r)?.items || [];
    },
    async upsert(plural, version, body) {
      const { api } = await kubeClients();
      const existing = await get(plural, version, body.metadata.name);
      if (!existing) {
        await api.createNamespacedCustomObject({ group: GROUP, version, namespace, plural, body });
        return;
      }
      body.metadata.resourceVersion = existing.metadata?.resourceVersion;
      await api.replaceNamespacedCustomObject({ group: GROUP, version, namespace, plural, name: body.metadata.name, body });
    },
    async remove(plural, version, name) {
      const { api } = await kubeClients();
      try {
        await api.deleteNamespacedCustomObject({ group: GROUP, version, namespace, plural, name });
      } catch (err) {
        if (status(err) !== 404) throw err;
      }
    },
    async ensureSecret(name, data) {
      const { core } = await kubeClients();
      const encoded = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
      try {
        const r: any = await core.readNamespacedSecret({ name, namespace });
        const s = r?.body || r;
        const same = Object.entries(encoded).every(([k, v]) => s.data?.[k] === v);
        if (same) return;
        s.data = { ...(s.data || {}), ...encoded };
        await core.replaceNamespacedSecret({ name, namespace, body: s });
      } catch (err) {
        if (status(err) !== 404) throw err;
        await core.createNamespacedSecret({
          namespace,
          body: { apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'platform-api' } }, type: 'Opaque', data: encoded },
        });
      }
    },
  };
}

export type LokiRulesClient = (method: 'post' | 'delete', path: string, body?: string) => Promise<void>;

const lokiHttp: LokiRulesClient = async (method, path, body) => {
  const url = `${alertingUrls().loki}${path}`;
  const res = await axios.request({ method, url, data: body, headers: body ? { 'Content-Type': 'application/yaml' } : {}, timeout: alertingSettings().queryTimeoutMs, validateStatus: () => true });
  if (res.status >= 300 && !(method === 'delete' && res.status === 404)) throw new Error(`Loki ruler ${method} ${path}: HTTP ${res.status}`);
};

export interface SyncResult {
  projectId: string;
  groups: number;
  lokiRules: number;
  errors: { id: string; error: string }[];
}

/** Render and apply one project's rule objects (deletes them when nothing is left). */
export async function syncProjectRules(projectId: string, objects: CustomObjects = kubeCustomObjects(), loki: LokiRulesClient = lokiHttp): Promise<SyncResult> {
  const ds = await getDb();
  const settings = alertingSettings();
  const urls = alertingUrls();
  const monitors = await ds.getRepository(AlertMonitor).find({ where: { projectId } });
  const slos = await ds.getRepository(AlertSlo).find({ where: { projectId } });
  const ctx = { namespaces: await projectNamespaces(projectId), ruleNamespace: settings.namespace, portal: urls.portal };
  const rendered = renderPrometheusRule(projectId, monitors, slos, ctx);
  const name = prometheusRuleName(projectId);
  const lokiGroup = renderLokiRuleGroup(projectId, monitors, ctx);
  const useLoki = lokiRulerEnabled() && lokiGroup.count > 0;
  const groups = rendered.object.spec.groups.length;

  if (groups === 0 && !useLoki) {
    await objects.remove('prometheusrules', 'v1', name);
    await objects.remove('alertmanagerconfigs', 'v1alpha1', name);
  } else {
    await objects.ensureSecret(WEBHOOK_TOKEN_SECRET, { token: alertmanagerWebhookToken() });
    if (groups > 0) await objects.upsert('prometheusrules', 'v1', rendered.object);
    else await objects.remove('prometheusrules', 'v1', name);
    await objects.upsert('alertmanagerconfigs', 'v1alpha1', renderAlertmanagerConfig(projectId, { namespace: settings.namespace, receiverUrl: urls.apiReceiver, tokenSecret: WEBHOOK_TOKEN_SECRET }));
  }
  if (lokiRulerEnabled()) {
    if (useLoki) await loki('post', '/loki/api/v1/rules/platform', lokiGroup.yaml);
    else await loki('delete', `/loki/api/v1/rules/platform/${encodeURIComponent(lokiGroup.name)}`);
  }
  return { projectId, groups, lokiRules: useLoki ? lokiGroup.count : 0, errors: rendered.errors };
}

/** Leader reconcile: every project with rules, and delete objects of projects without any. */
export async function syncAllRules(objects: CustomObjects = kubeCustomObjects(), loki: LokiRulesClient = lokiHttp): Promise<SyncResult[]> {
  if (alertingMode() !== 'ruler') return [];
  const ds = await getDb();
  const ids = new Set<string>();
  for (const m of await ds.getRepository(AlertMonitor).find()) ids.add(m.projectId);
  for (const s of await ds.getRepository(AlertSlo).find()) ids.add(s.projectId);
  const results: SyncResult[] = [];
  for (const id of ids) {
    try {
      results.push(await syncProjectRules(id, objects, loki));
    } catch (err: any) {
      results.push({ projectId: id, groups: 0, lokiRules: 0, errors: [{ id, error: String(err?.message || err) }] });
    }
  }
  const wanted = new Set([...ids].map(prometheusRuleName));
  for (const plural of [['prometheusrules', 'v1'], ['alertmanagerconfigs', 'v1alpha1']] as const) {
    try {
      for (const o of await objects.list(plural[0], plural[1], MANAGED)) {
        const n = o?.metadata?.name;
        if (n && n.startsWith('platform-alerts-') && !wanted.has(n)) await objects.remove(plural[0], plural[1], n);
      }
    } catch (err: any) {
      console.warn(`[alerting] could not list ${plural[0]}: ${err?.message || err}`);
    }
  }
  return results;
}

/** Fire-and-forget sync after a config change (ruler mode only; the leader reconciles anyway). */
export function scheduleRulesSync(projectId: string): void {
  if (alertingMode() !== 'ruler') return;
  syncProjectRules(projectId).catch((err) => console.warn(`[alerting] rule sync for ${projectId} failed: ${err?.message || err}`));
}

// ---------------------------------------------------------------------------
// Alertmanager silences
// ---------------------------------------------------------------------------

const AM_LABEL_ALIASES: Record<string, string> = { source: 'platform_source' };
const PROM_LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Alertmanager matchers for a silence, or null when it cannot be expressed there (API still enforces it). */
export function alertmanagerMatchers(s: Pick<AlertSilence, 'projectId' | 'matchers'>) {
  const out = [{ name: 'project', value: s.projectId, isRegex: false, isEqual: true }];
  for (const m of s.matchers || []) {
    const name = AM_LABEL_ALIASES[m.name] || m.name;
    if (name === 'dedupeKey' || name === 'project' || !PROM_LABEL.test(name)) return null;
    out.push({ name, value: m.value, isRegex: !!m.isRegex, isEqual: m.isEqual !== false });
  }
  return out;
}

export type AlertmanagerHttp = (method: 'post' | 'delete', path: string, body?: any) => Promise<any>;

const amHttp: AlertmanagerHttp = async (method, path, body) => {
  const res = await axios.request({ method, url: `${alertingUrls().alertmanager}${path}`, data: body, timeout: alertingSettings().queryTimeoutMs, validateStatus: () => true });
  if (res.status >= 300 && !(method === 'delete' && res.status === 404)) throw new Error(`Alertmanager ${method} ${path}: HTTP ${res.status}`);
  return res.data;
};

export async function mirrorSilence(s: AlertSilence, http: AlertmanagerHttp = amHttp): Promise<string | null> {
  if (alertingMode() !== 'ruler') return null;
  const matchers = alertmanagerMatchers(s);
  if (!matchers) return null;
  const data = await http('post', '/api/v2/silences', {
    matchers,
    startsAt: new Date(s.startsAt).toISOString(),
    endsAt: new Date(s.endsAt).toISOString(),
    createdBy: 'platform-api',
    comment: s.comment || `${s.kind} ${s.id}`,
  });
  return data?.silenceID ? String(data.silenceID) : null;
}

export async function expireMirroredSilence(alertmanagerId: string | null, http: AlertmanagerHttp = amHttp): Promise<void> {
  if (!alertmanagerId || alertingMode() !== 'ruler') return;
  if (!/^[0-9a-f-]{8,64}$/i.test(alertmanagerId)) return;
  await http('delete', `/api/v2/silence/${alertmanagerId}`);
}
