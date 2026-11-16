/**
 * Cost estimates from metered usage and admin unit prices (#57).
 * Estimates only — no billing/payment.
 */
import { UsageMetrics, roundUsage } from './usage-metrics';

export interface UsagePrices {
  perCoreHour: number;
  perGbHourMemory: number;
  perGbMonthStorage: number;
  perGbBandwidth: number;
  perBuildMinute: number;
  /** Fixed monthly server cost allocated by usage share when > 0. */
  monthlyServerCost: number;
  currency: string;
}

export const DEFAULT_USAGE_PRICES: UsagePrices = {
  perCoreHour: 0.04,
  perGbHourMemory: 0.005,
  perGbMonthStorage: 0.02,
  perGbBandwidth: 0.09,
  perBuildMinute: 0.002,
  monthlyServerCost: 0,
  currency: 'USD',
};

export interface CostBreakdown {
  cpu: number;
  memory: number;
  storage: number;
  bandwidth: number;
  build: number;
  /** Share of monthlyServerCost for this row (0 when not allocated yet). */
  serverShare: number;
  total: number;
}

/** Direct cost for one metrics bag over `dayCount` days (storage priced as GB-month / 30 * days). */
export function directCost(metrics: UsageMetrics, prices: UsagePrices, dayCount = 1): CostBreakdown {
  const days = Math.max(0, dayCount);
  const storageGb = metrics.pvcStorageGb + metrics.objectStorageGb;
  const cpu = metrics.cpuCoreHours * prices.perCoreHour;
  const memory = metrics.memoryGbHours * prices.perGbHourMemory;
  // Average daily storage footprint × (price per GB-month / 30) × days.
  const storage = storageGb * (prices.perGbMonthStorage / 30) * days;
  const bandwidth = metrics.ingressBandwidthGb * prices.perGbBandwidth;
  const build = metrics.buildMinutes * prices.perBuildMinute;
  const total = cpu + memory + storage + bandwidth + build;
  return {
    cpu: roundUsage(cpu, 4),
    memory: roundUsage(memory, 4),
    storage: roundUsage(storage, 4),
    bandwidth: roundUsage(bandwidth, 4),
    build: roundUsage(build, 4),
    serverShare: 0,
    total: roundUsage(total, 4),
  };
}

/**
 * Weight used to allocate monthly server cost across projects.
 * Prefers metered "compute + memory" so idle storage-heavy projects don't dominate.
 */
export function allocationWeight(metrics: UsageMetrics): number {
  return Math.max(0, metrics.cpuCoreHours + metrics.memoryGbHours * 0.25);
}

/**
 * Attach proportional shares of `monthlyServerCost` for a billing period of `periodDays`.
 * `monthlyServerCost` is scaled to the period (periodDays / 30).
 */
export function allocateServerCost<T extends { metrics: UsageMetrics; cost: CostBreakdown }>(
  rows: T[],
  prices: UsagePrices,
  periodDays: number,
): T[] {
  const periodCost = prices.monthlyServerCost * (Math.max(0, periodDays) / 30);
  if (!(periodCost > 0) || !rows.length) return rows;
  const weights = rows.map((r) => allocationWeight(r.metrics));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    // Equal share when nothing was metered.
    const each = periodCost / rows.length;
    return rows.map((r) => {
      const serverShare = roundUsage(each, 4);
      return { ...r, cost: { ...r.cost, serverShare, total: roundUsage(r.cost.total + serverShare, 4) } };
    });
  }
  return rows.map((r, i) => {
    const serverShare = roundUsage(periodCost * (weights[i] / sum), 4);
    return { ...r, cost: { ...r.cost, serverShare, total: roundUsage(r.cost.total + serverShare, 4) } };
  });
}

export function parsePrices(raw: Partial<UsagePrices> | null | undefined): UsagePrices {
  const n = (v: unknown, fallback: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? x : fallback;
  };
  return {
    perCoreHour: n(raw?.perCoreHour, DEFAULT_USAGE_PRICES.perCoreHour),
    perGbHourMemory: n(raw?.perGbHourMemory, DEFAULT_USAGE_PRICES.perGbHourMemory),
    perGbMonthStorage: n(raw?.perGbMonthStorage, DEFAULT_USAGE_PRICES.perGbMonthStorage),
    perGbBandwidth: n(raw?.perGbBandwidth, DEFAULT_USAGE_PRICES.perGbBandwidth),
    perBuildMinute: n(raw?.perBuildMinute, DEFAULT_USAGE_PRICES.perBuildMinute),
    monthlyServerCost: n(raw?.monthlyServerCost, DEFAULT_USAGE_PRICES.monthlyServerCost),
    currency: typeof raw?.currency === 'string' && raw.currency.trim()
      ? raw.currency.trim().slice(0, 8).toUpperCase()
      : DEFAULT_USAGE_PRICES.currency,
  };
}

/** CSV header + rows for usage export. */
export function usageCsv(
  rows: Array<{
    day: string;
    projectId: string;
    projectName?: string;
    environmentName: string | null;
    namespace: string | null;
    metrics: UsageMetrics;
    cost?: CostBreakdown;
  }>,
): string {
  const header = [
    'day', 'projectId', 'projectName', 'environment', 'namespace',
    'cpuCoreHours', 'memoryGbHours', 'pvcStorageGb', 'objectStorageGb',
    'ingressBandwidthGb', 'buildMinutes', 'estimatedCost',
  ];
  const escape = (v: unknown) => {
    let s = v == null ? '' : String(v);
    // Spreadsheets run cells starting with = + - @ (or tab/CR) as formulas; neutralise text cells.
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.day,
      r.projectId,
      r.projectName || '',
      r.environmentName || '',
      r.namespace || '',
      r.metrics.cpuCoreHours,
      r.metrics.memoryGbHours,
      r.metrics.pvcStorageGb,
      r.metrics.objectStorageGb,
      r.metrics.ingressBandwidthGb,
      r.metrics.buildMinutes,
      r.cost?.total ?? '',
    ].map(escape).join(','));
  }
  return lines.join('\n') + '\n';
}
