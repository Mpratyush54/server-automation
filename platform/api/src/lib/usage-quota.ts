/**
 * Usage quotas and threshold alerts (#57). Soft caps fire alerts at 80% / 100%;
 * optional `resourceQuota` overrides feed the namespace ResourceQuota baseline.
 */
import { UsageMetrics, roundUsage } from './usage-metrics';
import type { AlertEvent, AlertSeverity } from './alert-events';

export interface QuotaLimits {
  cpuCoreHours: number | null;
  memoryGbHours: number | null;
  storageGb: number | null;
  bandwidthGb: number | null;
  buildMinutes: number | null;
  resourceQuota: Record<string, string> | null;
  alertsEnabled: boolean;
}

export type QuotaMetric = 'cpuCoreHours' | 'memoryGbHours' | 'storageGb' | 'bandwidthGb' | 'buildMinutes';

export interface QuotaUsage {
  cpuCoreHours: number;
  memoryGbHours: number;
  storageGb: number;
  bandwidthGb: number;
  buildMinutes: number;
}

export interface QuotaBreach {
  metric: QuotaMetric;
  used: number;
  limit: number;
  /** 0..∞ ratio of used/limit. */
  ratio: number;
  /** 'warning' at ≥80%, 'critical' at ≥100%. */
  level: 'warning' | 'critical';
}

export const QUOTA_WARNING = 0.8;
export const QUOTA_CRITICAL = 1.0;

export function usageAgainstQuota(metrics: UsageMetrics): QuotaUsage {
  return {
    cpuCoreHours: metrics.cpuCoreHours,
    memoryGbHours: metrics.memoryGbHours,
    storageGb: metrics.pvcStorageGb + metrics.objectStorageGb,
    bandwidthGb: metrics.ingressBandwidthGb,
    buildMinutes: metrics.buildMinutes,
  };
}

export function quotaBreaches(used: QuotaUsage, limits: QuotaLimits): QuotaBreach[] {
  if (!limits.alertsEnabled) return [];
  const out: QuotaBreach[] = [];
  const check = (metric: QuotaMetric, value: number, limit: number | null) => {
    if (limit == null || !(limit > 0) || !(value > 0)) return;
    const ratio = value / limit;
    if (ratio < QUOTA_WARNING) return;
    out.push({
      metric,
      used: roundUsage(value, 4),
      limit,
      ratio: roundUsage(ratio, 4),
      level: ratio >= QUOTA_CRITICAL ? 'critical' : 'warning',
    });
  };
  check('cpuCoreHours', used.cpuCoreHours, limits.cpuCoreHours);
  check('memoryGbHours', used.memoryGbHours, limits.memoryGbHours);
  check('storageGb', used.storageGb, limits.storageGb);
  check('bandwidthGb', used.bandwidthGb, limits.bandwidthGb);
  check('buildMinutes', used.buildMinutes, limits.buildMinutes);
  return out;
}

export function quotaPercent(used: number, limit: number | null): number | null {
  if (limit == null || !(limit > 0)) return null;
  return roundUsage((used / limit) * 100, 2);
}

export function quotaBars(used: QuotaUsage, limits: QuotaLimits): Record<QuotaMetric, { used: number; limit: number | null; percent: number | null }> {
  return {
    cpuCoreHours: { used: used.cpuCoreHours, limit: limits.cpuCoreHours, percent: quotaPercent(used.cpuCoreHours, limits.cpuCoreHours) },
    memoryGbHours: { used: used.memoryGbHours, limit: limits.memoryGbHours, percent: quotaPercent(used.memoryGbHours, limits.memoryGbHours) },
    storageGb: { used: used.storageGb, limit: limits.storageGb, percent: quotaPercent(used.storageGb, limits.storageGb) },
    bandwidthGb: { used: used.bandwidthGb, limit: limits.bandwidthGb, percent: quotaPercent(used.bandwidthGb, limits.bandwidthGb) },
    buildMinutes: { used: used.buildMinutes, limit: limits.buildMinutes, percent: quotaPercent(used.buildMinutes, limits.buildMinutes) },
  };
}

const METRIC_LABEL: Record<QuotaMetric, string> = {
  cpuCoreHours: 'CPU core-hours',
  memoryGbHours: 'Memory GB-hours',
  storageGb: 'Storage GB',
  bandwidthGb: 'Bandwidth GB',
  buildMinutes: 'Build minutes',
};

/** Stable dedupe key so 80% and 100% escalate the same incident. */
export function quotaDedupeKey(projectId: string, metric: QuotaMetric): string {
  return `usage-quota:${projectId}:${metric}`;
}

export function breachToAlertEvent(projectId: string, breach: QuotaBreach): AlertEvent {
  const pct = Math.round(breach.ratio * 100);
  const severity: AlertSeverity = breach.level === 'critical' ? 'critical' : 'warning';
  const title = breach.level === 'critical'
    ? `Usage quota exceeded: ${METRIC_LABEL[breach.metric]}`
    : `Usage quota warning: ${METRIC_LABEL[breach.metric]}`;
  return {
    projectId,
    source: 'usage',
    severity,
    dedupeKey: quotaDedupeKey(projectId, breach.metric),
    title,
    body: `${METRIC_LABEL[breach.metric]} is at ${pct}% of quota (${breach.used} / ${breach.limit}).`,
    url: `/projects/${projectId}?tab=monitoring&view=usage`,
    status: 'firing',
    labels: {
      platform_source: 'usage',
      metric: breach.metric,
      level: breach.level,
    },
  };
}

export function resolveQuotaAlert(projectId: string, metric: QuotaMetric): AlertEvent {
  return {
    projectId,
    source: 'usage',
    severity: 'info',
    dedupeKey: quotaDedupeKey(projectId, metric),
    title: `Usage quota recovered: ${METRIC_LABEL[metric]}`,
    body: `${METRIC_LABEL[metric]} is back under the warning threshold.`,
    url: `/projects/${projectId}?tab=monitoring&view=usage`,
    status: 'resolved',
    labels: { platform_source: 'usage', metric },
  };
}

/** Whitelist of ResourceQuota hard keys we accept from the portal/API. */
const RQ_KEYS = new Set([
  'requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory',
  'requests.storage', 'persistentvolumeclaims', 'pods', 'count/services',
]);

export function parseResourceQuota(raw: unknown): Record<string, string> | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('resourceQuota must be an object');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!RQ_KEYS.has(k)) throw new Error(`unsupported resourceQuota key: ${k}`);
    const s = String(v ?? '').trim();
    if (!s || s.length > 32) throw new Error(`invalid resourceQuota value for ${k}`);
    if (!/^[0-9]+([.][0-9]+)?(m|Mi|Gi|Ti|Ki)?$/.test(s) && !/^[0-9]+$/.test(s)) {
      throw new Error(`invalid resourceQuota value for ${k}`);
    }
    out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

export function parseQuotaBody(body: any): Partial<QuotaLimits> {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error('quota values must be non-negative numbers or null');
    return n;
  };
  const out: Partial<QuotaLimits> = {};
  if ('cpuCoreHours' in (body || {})) out.cpuCoreHours = num(body.cpuCoreHours);
  if ('memoryGbHours' in (body || {})) out.memoryGbHours = num(body.memoryGbHours);
  if ('storageGb' in (body || {})) out.storageGb = num(body.storageGb);
  if ('bandwidthGb' in (body || {})) out.bandwidthGb = num(body.bandwidthGb);
  if ('buildMinutes' in (body || {})) out.buildMinutes = num(body.buildMinutes);
  if ('resourceQuota' in (body || {})) out.resourceQuota = parseResourceQuota(body.resourceQuota);
  if ('alertsEnabled' in (body || {})) out.alertsEnabled = body.alertsEnabled !== false;
  return out;
}

/** Default empty quota row shape. */
export function emptyQuota(projectId: string): QuotaLimits & { projectId: string } {
  return {
    projectId,
    cpuCoreHours: null,
    memoryGbHours: null,
    storageGb: null,
    bandwidthGb: null,
    buildMinutes: null,
    resourceQuota: null,
    alertsEnabled: true,
  };
}
