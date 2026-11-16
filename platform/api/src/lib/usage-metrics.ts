/**
 * Usage metering helpers (#57): Prometheus query shapes, unit conversion, and
 * daily rollup aggregation. Pure functions are unit-tested with fixed vectors.
 */
import { PromResult, promInstant, vectorBy } from './observability-backends';

export const GiB = 1024 ** 3;
export const HOUR = 3600;
export const DAY_SECONDS = 86_400;

export interface UsageMetrics {
  cpuCoreHours: number;
  memoryGbHours: number;
  pvcStorageGb: number;
  objectStorageGb: number;
  ingressBandwidthGb: number;
  buildMinutes: number;
}

export const EMPTY_METRICS: UsageMetrics = {
  cpuCoreHours: 0,
  memoryGbHours: 0,
  pvcStorageGb: 0,
  objectStorageGb: 0,
  ingressBandwidthGb: 0,
  buildMinutes: 0,
};

export function addMetrics(a: UsageMetrics, b: UsageMetrics): UsageMetrics {
  return {
    cpuCoreHours: a.cpuCoreHours + b.cpuCoreHours,
    memoryGbHours: a.memoryGbHours + b.memoryGbHours,
    pvcStorageGb: a.pvcStorageGb + b.pvcStorageGb,
    objectStorageGb: a.objectStorageGb + b.objectStorageGb,
    ingressBandwidthGb: a.ingressBandwidthGb + b.ingressBandwidthGb,
    buildMinutes: a.buildMinutes + b.buildMinutes,
  };
}

export function roundUsage(n: number, digits = 6): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** UTC calendar day `YYYY-MM-DD` for a Date. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Start/end unix seconds for a UTC calendar day (inclusive start, exclusive end). */
export function dayWindow(day: string): { start: number; end: number; hours: number } {
  const start = Date.parse(`${day}T00:00:00.000Z`) / 1000;
  if (!Number.isFinite(start)) throw new Error(`invalid day ${day}`);
  return { start, end: start + DAY_SECONDS, hours: 24 };
}

/** Previous completed UTC day (collector default). */
export function previousUtcDay(now = new Date()): string {
  return utcDay(new Date(now.getTime() - DAY_SECONDS * 1000));
}

export interface EnvTarget {
  projectId: string;
  environmentId: string;
  environmentName: string;
  namespace: string;
  host: string | null;
}

/** Escape a value for a Prometheus label matcher. */
export function promLabelValue(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Regex alternation of namespaces/hosts for PromQL. */
export function promRegex(values: string[]): string {
  const uniq = [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
  return uniq.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * PromQL used for a daily rollup. Window is the day length so `increase(...[1d])`
 * lines up with the calendar day the collector writes.
 */
export function usageQueries(namespaces: string[], hosts: string[], window = '1d'): {
  cpu: string;
  memory: string;
  pvc: string;
  ingress: string;
} {
  const ns = promRegex(namespaces) || 'none';
  const host = promRegex(hosts) || 'none';
  return {
    // Core-seconds over the window → later / 3600 = core-hours.
    cpu: `sum by (namespace) (increase(container_cpu_usage_seconds_total{container!="",namespace=~"${ns}"}[${window}]))`,
    // Average working-set bytes → later * hours / GiB = GB-hours.
    memory: `sum by (namespace) (avg_over_time(container_memory_working_set_bytes{container!="",namespace=~"${ns}"}[${window}]))`,
    pvc: `sum by (namespace) (kubelet_volume_stats_used_bytes{namespace=~"${ns}"})`,
    // Prefer bytes_sent; controllers without it still expose response size sums.
    ingress: `sum by (host) (increase(nginx_ingress_controller_bytes_sent{host=~"${host}"}[${window}]) or increase(nginx_ingress_controller_response_size_sum{host=~"${host}"}[${window}]))`,
  };
}

/** Core-seconds → core-hours. */
export function coreSecondsToHours(coreSeconds: number): number {
  return roundUsage(coreSeconds / HOUR);
}

/** Average memory bytes over `hours` → GB-hours. */
export function memoryBytesToGbHours(avgBytes: number, hours: number): number {
  return roundUsage((avgBytes / GiB) * hours);
}

export function bytesToGb(bytes: number): number {
  return roundUsage(bytes / GiB);
}

/**
 * Build per-namespace / per-host metrics from fixed Prometheus instant vectors.
 * Used by the collector and by unit tests with canned responses.
 */
export function metricsFromPromVectors(opts: {
  cpuByNs: Map<string, number>;
  memoryBytesByNs: Map<string, number>;
  pvcBytesByNs: Map<string, number>;
  ingressBytesByHost: Map<string, number>;
  hours: number;
}): {
  byNamespace: Map<string, Pick<UsageMetrics, 'cpuCoreHours' | 'memoryGbHours' | 'pvcStorageGb'>>;
  byHost: Map<string, number>;
} {
  const byNamespace = new Map<string, Pick<UsageMetrics, 'cpuCoreHours' | 'memoryGbHours' | 'pvcStorageGb'>>();
  const keys = new Set([...opts.cpuByNs.keys(), ...opts.memoryBytesByNs.keys(), ...opts.pvcBytesByNs.keys()]);
  for (const ns of keys) {
    byNamespace.set(ns, {
      cpuCoreHours: coreSecondsToHours(opts.cpuByNs.get(ns) || 0),
      memoryGbHours: memoryBytesToGbHours(opts.memoryBytesByNs.get(ns) || 0, opts.hours),
      pvcStorageGb: bytesToGb(opts.pvcBytesByNs.get(ns) || 0),
    });
  }
  const byHost = new Map<string, number>();
  for (const [host, bytes] of opts.ingressBytesByHost) byHost.set(host, bytesToGb(bytes));
  return { byNamespace, byHost };
}

export function parsePromVector(res: PromResult, label: string): Map<string, number> {
  return vectorBy(res, label);
}

export type PromQueryFn = (query: string, time?: number) => Promise<PromResult>;

/** Query Prometheus for one day's namespace/host vectors. */
export async function fetchDayVectors(
  namespaces: string[],
  hosts: string[],
  dayEndUnix: number,
  query: PromQueryFn = promInstant,
): Promise<{
  cpuByNs: Map<string, number>;
  memoryBytesByNs: Map<string, number>;
  pvcBytesByNs: Map<string, number>;
  ingressBytesByHost: Map<string, number>;
}> {
  if (!namespaces.length) {
    return {
      cpuByNs: new Map(),
      memoryBytesByNs: new Map(),
      pvcBytesByNs: new Map(),
      ingressBytesByHost: new Map(),
    };
  }
  const q = usageQueries(namespaces, hosts);
  const [cpu, memory, pvc, ingress] = await Promise.all([
    query(q.cpu, dayEndUnix),
    query(q.memory, dayEndUnix),
    query(q.pvc, dayEndUnix),
    hosts.length ? query(q.ingress, dayEndUnix) : Promise.resolve({ resultType: 'vector', result: [], truncated: false }),
  ]);
  return {
    cpuByNs: parsePromVector(cpu, 'namespace'),
    memoryBytesByNs: parsePromVector(memory, 'namespace'),
    pvcBytesByNs: parsePromVector(pvc, 'namespace'),
    ingressBytesByHost: parsePromVector(ingress, 'host'),
  };
}

/**
 * Assemble one environment's daily metrics from pre-fetched vectors + object storage + build minutes.
 */
export function assembleEnvMetrics(opts: {
  namespace: string;
  host: string | null;
  byNamespace: Map<string, Pick<UsageMetrics, 'cpuCoreHours' | 'memoryGbHours' | 'pvcStorageGb'>>;
  byHost: Map<string, number>;
  objectStorageGb: number;
  buildMinutes: number;
}): UsageMetrics {
  const ns = opts.byNamespace.get(opts.namespace) || { cpuCoreHours: 0, memoryGbHours: 0, pvcStorageGb: 0 };
  const hostKey = opts.host || '';
  const bandwidth = hostKey ? (opts.byHost.get(hostKey) || 0) : 0;
  return {
    cpuCoreHours: ns.cpuCoreHours,
    memoryGbHours: ns.memoryGbHours,
    pvcStorageGb: ns.pvcStorageGb,
    objectStorageGb: roundUsage(opts.objectStorageGb),
    ingressBandwidthGb: bandwidth,
    buildMinutes: roundUsage(opts.buildMinutes),
  };
}

/** Sum daily rows into totals (object storage uses max/last, not sum — caller chooses). */
export function sumRollupMetrics(rows: UsageMetrics[], opts?: { storageMode?: 'sum' | 'max' }): UsageMetrics {
  const mode = opts?.storageMode || 'sum';
  const out = { ...EMPTY_METRICS };
  for (const r of rows) {
    out.cpuCoreHours += r.cpuCoreHours;
    out.memoryGbHours += r.memoryGbHours;
    out.ingressBandwidthGb += r.ingressBandwidthGb;
    out.buildMinutes += r.buildMinutes;
    out.objectStorageGb = mode === 'max'
      ? Math.max(out.objectStorageGb, r.objectStorageGb)
      : out.objectStorageGb + r.objectStorageGb;
    out.pvcStorageGb = mode === 'max'
      ? Math.max(out.pvcStorageGb, r.pvcStorageGb)
      : out.pvcStorageGb + r.pvcStorageGb;
  }
  return {
    cpuCoreHours: roundUsage(out.cpuCoreHours),
    memoryGbHours: roundUsage(out.memoryGbHours),
    pvcStorageGb: roundUsage(out.pvcStorageGb),
    objectStorageGb: roundUsage(out.objectStorageGb),
    ingressBandwidthGb: roundUsage(out.ingressBandwidthGb),
    buildMinutes: roundUsage(out.buildMinutes),
  };
}
