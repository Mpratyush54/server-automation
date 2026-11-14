/**
 * Daily usage collector (#57): leader job that queries Prometheus for the previous
 * UTC day, merges object-storage analytics + build minutes, upserts rollups, and
 * fires quota alerts at 80%/100% of the current month.
 *
 * Keeps single-server installs light: one set of PromQL queries per run, no OpenCost.
 */
import type { DataSource } from 'typeorm';
import { getDb } from '../config/database';
import { Environment } from '../entities/Environment';
import { File } from '../entities/File';
import { Project } from '../entities/Project';
import { UsageDailyRollup } from '../entities/UsageDailyRollup';
import { UsageQuota } from '../entities/UsageQuota';
import { UsageSettings } from '../entities/UsageSettings';
import { registerLeaderJob } from './scheduler';
import { emitAlertEvent } from './alerting-engine';
import {
  EnvTarget,
  UsageMetrics,
  assembleEnvMetrics,
  dayWindow,
  fetchDayVectors,
  metricsFromPromVectors,
  previousUtcDay,
  roundUsage,
  sumRollupMetrics,
  utcDay,
} from './usage-metrics';
import { DEFAULT_USAGE_PRICES, UsagePrices, parsePrices } from './usage-cost';
import {
  QuotaLimits,
  QuotaMetric,
  breachToAlertEvent,
  quotaBreaches,
  resolveQuotaAlert,
  usageAgainstQuota,
} from './usage-quota';
export const USAGE_COLLECTOR_JOB = 'usage-collector';
/** Default: every 6 hours (idempotent upsert of the previous day). */
export const USAGE_COLLECTOR_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function getOrCreateUsageSettings(ds?: DataSource): Promise<UsageSettings> {
  const db = ds || await getDb();
  const repo = db.getRepository(UsageSettings);
  const existing = await repo.find({ take: 1 });
  if (existing[0]) return existing[0];
  return repo.save(repo.create({ ...DEFAULT_USAGE_PRICES }));
}

export async function loadUsagePrices(ds?: DataSource): Promise<UsagePrices> {
  const row = await getOrCreateUsageSettings(ds);
  return parsePrices(row);
}

export async function listEnvTargets(ds: DataSource): Promise<EnvTarget[]> {
  const envs = await ds.getRepository(Environment).find({ where: { isActive: true } as any });
  return envs
    .filter((e) => e.namespace && e.projectId)
    .map((e) => ({
      projectId: e.projectId,
      environmentId: e.id,
      environmentName: String(e.name),
      namespace: e.namespace,
      host: e.domain || null,
    }));
}

/** Object storage bytes currently stored per project (uploads table). */
export async function objectStorageBytesByProject(ds: DataSource): Promise<Map<string, number>> {
  const files = await ds.getRepository(File).find({ where: { isDeleted: false } as any });
  const out = new Map<string, number>();
  for (const f of files) {
    out.set(f.projectId, (out.get(f.projectId) || 0) + Number(f.size || 0));
  }
  return out;
}

/**
 * Build / deploy minutes for a calendar day from deployment rows
 * (created_at → deployed_at). Falls back to 0 when unavailable.
 */
export async function buildMinutesByEnv(ds: DataSource, day: string): Promise<Map<string, number>> {
  const { start, end } = dayWindow(day);
  const startDate = new Date(start * 1000);
  const endDate = new Date(end * 1000);
  try {
    const rows: { environment_id: string; minutes: string }[] = await ds.query(
      `SELECT environment_id::text AS environment_id,
              COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(deployed_at, created_at) - created_at))) / 60.0, 0)::text AS minutes
         FROM deployments
        WHERE environment_id IS NOT NULL
          AND created_at >= $1 AND created_at < $2
        GROUP BY environment_id`,
      [startDate, endDate],
    );
    const out = new Map<string, number>();
    for (const r of rows) out.set(String(r.environment_id), roundUsage(Number(r.minutes) || 0, 2));
    return out;
  } catch {
    return new Map();
  }
}

export async function upsertDailyRollup(
  ds: DataSource,
  row: {
    projectId: string;
    environmentId: string | null;
    environmentName: string | null;
    namespace: string | null;
    day: string;
    metrics: UsageMetrics;
  },
): Promise<UsageDailyRollup> {
  const repo = ds.getRepository(UsageDailyRollup);
  let existing = await repo.findOne({
    where: {
      projectId: row.projectId,
      environmentId: row.environmentId as any,
      day: row.day as any,
    },
  });
  // Postgres UNIQUE (project_id, environment_id, day) treats NULLs as distinct;
  // look up project-wide rows (null env) explicitly when needed.
  if (!existing && row.environmentId == null) {
    const candidates = await repo.find({ where: { projectId: row.projectId, day: row.day as any } });
    existing = candidates.find((c) => c.environmentId == null) || null;
  }
  const data = {
    projectId: row.projectId,
    environmentId: row.environmentId,
    environmentName: row.environmentName,
    namespace: row.namespace,
    day: row.day,
    cpuCoreHours: row.metrics.cpuCoreHours,
    memoryGbHours: row.metrics.memoryGbHours,
    pvcStorageGb: row.metrics.pvcStorageGb,
    objectStorageGb: row.metrics.objectStorageGb,
    ingressBandwidthGb: row.metrics.ingressBandwidthGb,
    buildMinutes: row.metrics.buildMinutes,
  };
  if (existing) {
    Object.assign(existing, data);
    return repo.save(existing);
  }
  return repo.save(repo.create(data));
}

export interface CollectResult {
  day: string;
  environments: number;
  rollups: number;
  alerts: number;
  skipped?: string;
}

/**
 * Collect usage for one UTC day. Idempotent: re-running overwrites the same day rows.
 */
export async function collectUsageDay(
  ds: DataSource,
  day: string,
  opts: {
    fetchVectors?: typeof fetchDayVectors;
    emit?: typeof emitAlertEvent;
  } = {},
): Promise<CollectResult> {
  const fetchVectors = opts.fetchVectors || fetchDayVectors;
  const emit = opts.emit || emitAlertEvent;
  const targets = await listEnvTargets(ds);
  if (!targets.length) return { day, environments: 0, rollups: 0, alerts: 0, skipped: 'no environments' };

  const namespaces = targets.map((t) => t.namespace);
  const hosts = targets.map((t) => t.host).filter((h): h is string => !!h);
  const { end, hours } = dayWindow(day);

  let vectors: Awaited<ReturnType<typeof fetchDayVectors>>;
  try {
    vectors = await fetchVectors(namespaces, hosts, end);
  } catch (err: any) {
    console.warn(`[usage] prometheus query failed for ${day}: ${err?.message || err}`);
    return { day, environments: targets.length, rollups: 0, alerts: 0, skipped: 'prometheus unavailable' };
  }

  const { byNamespace, byHost } = metricsFromPromVectors({
    cpuByNs: vectors.cpuByNs,
    memoryBytesByNs: vectors.memoryBytesByNs,
    pvcBytesByNs: vectors.pvcBytesByNs,
    ingressBytesByHost: vectors.ingressBytesByHost,
    hours,
  });

  const objectBytes = await objectStorageBytesByProject(ds);
  const builds = await buildMinutesByEnv(ds, day);

  // Object storage is project-scoped: attribute it once on the first env of each project for the day,
  // and leave sibling envs at 0 so monthly sums stay correct.
  const objectAttributed = new Set<string>();
  let rollups = 0;
  for (const t of targets) {
    let objectGb = 0;
    if (!objectAttributed.has(t.projectId)) {
      objectGb = roundUsage((objectBytes.get(t.projectId) || 0) / (1024 ** 3));
      objectAttributed.add(t.projectId);
    }
    const metrics = assembleEnvMetrics({
      namespace: t.namespace,
      host: t.host,
      byNamespace,
      byHost,
      objectStorageGb: objectGb,
      buildMinutes: builds.get(t.environmentId) || 0,
    });
    await upsertDailyRollup(ds, {
      projectId: t.projectId,
      environmentId: t.environmentId,
      environmentName: t.environmentName,
      namespace: t.namespace,
      day,
      metrics,
    });
    rollups++;
  }

  const alerts = await evaluateMonthlyQuotaAlerts(ds, day, emit);
  return { day, environments: targets.length, rollups, alerts };
}

/** Month-to-date usage for a project (inclusive from month start through `throughDay`). */
export async function monthToDateMetrics(ds: DataSource, projectId: string, throughDay: string): Promise<UsageMetrics> {
  const monthStart = throughDay.slice(0, 8) + '01';
  const rows = await ds.getRepository(UsageDailyRollup).find({
    where: { projectId } as any,
  });
  const inRange = rows.filter((r) => String(r.day).slice(0, 10) >= monthStart && String(r.day).slice(0, 10) <= throughDay);
  return sumRollupMetrics(
    inRange.map((r) => ({
      cpuCoreHours: Number(r.cpuCoreHours) || 0,
      memoryGbHours: Number(r.memoryGbHours) || 0,
      pvcStorageGb: Number(r.pvcStorageGb) || 0,
      objectStorageGb: Number(r.objectStorageGb) || 0,
      ingressBandwidthGb: Number(r.ingressBandwidthGb) || 0,
      buildMinutes: Number(r.buildMinutes) || 0,
    })),
    // Storage: average of daily snapshots ≈ sum/days is wrong for quota; use max footprint.
    { storageMode: 'max' },
  );
}

export async function evaluateMonthlyQuotaAlerts(
  ds: DataSource,
  throughDay: string,
  emit: typeof emitAlertEvent = emitAlertEvent,
): Promise<number> {
  const quotas = await ds.getRepository(UsageQuota).find();
  let fired = 0;
  for (const q of quotas) {
    if (!q.alertsEnabled) continue;
    const limits: QuotaLimits = {
      cpuCoreHours: q.cpuCoreHours,
      memoryGbHours: q.memoryGbHours,
      storageGb: q.storageGb,
      bandwidthGb: q.bandwidthGb,
      buildMinutes: q.buildMinutes,
      resourceQuota: q.resourceQuota,
      alertsEnabled: q.alertsEnabled,
    };
    const metrics = await monthToDateMetrics(ds, q.projectId, throughDay);
    const used = usageAgainstQuota(metrics);
    const breaches = quotaBreaches(used, limits);
    const breached = new Set(breaches.map((b) => b.metric));
    for (const b of breaches) {
      await emit(breachToAlertEvent(q.projectId, b));
      fired++;
    }
    // Resolve metrics that were previously over warning but are now fine.
    for (const metric of ['cpuCoreHours', 'memoryGbHours', 'storageGb', 'bandwidthGb', 'buildMinutes'] as QuotaMetric[]) {
      if (breached.has(metric)) continue;
      const limit = limits[metric];
      if (limit == null || !(limit > 0)) continue;
      if (used[metric] / limit < 0.8) {
        await emit(resolveQuotaAlert(q.projectId, metric));
      }
    }
  }
  return fired;
}

/** Apply stored ResourceQuota overrides onto every active environment of a project. */
export async function applyProjectResourceQuota(projectId: string, resourceQuota: Record<string, string> | null): Promise<void> {
  // Dynamic import keeps the usage collector loadable in Jest without pulling the
  // ESM-only @kubernetes/client-node graph used by namespace-baseline.
  const { ensureProjectNamespace, namespaceSettings } = await import('./namespace-baseline');
  const ds = await getDb();
  const project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
  if (!project) return;
  const envs = await ds.getRepository(Environment).find({ where: { projectId, isActive: true } as any });
  for (const env of envs) {
    const base = namespaceSettings(projectId, env.name);
    const settings = {
      ...base,
      quota: { ...(base.quota || {}), ...(resourceQuota || {}) },
    };
    try {
      await ensureProjectNamespace(projectId, { name: env.name, namespace: env.namespace }, { settings, enforceExisting: false });
    } catch (err: any) {
      console.warn(`[usage] ResourceQuota apply failed for ${env.namespace}: ${err?.message || err}`);
    }
  }
}

export async function runUsageCollector(now = new Date()): Promise<CollectResult | 'skipped'> {
  // Skip when observability is not installed (minimal/standard profiles).
  if (String(process.env.PLATFORM_OBSERVABILITY || '').toLowerCase() === 'disabled') {
    return 'skipped';
  }
  const ds = await getDb();
  const day = previousUtcDay(now);
  // Also refresh "today" so the portal month-to-date is current; best-effort.
  const today = utcDay(now);
  const prev = await collectUsageDay(ds, day);
  if (today !== day) {
    try { await collectUsageDay(ds, today); } catch { /* previous day is the durable rollup */ }
  }
  if (prev.rollups) console.log(`[usage] rolled up ${prev.rollups} env(s) for ${day} (${prev.alerts} quota alert(s))`);
  return prev;
}

export function startUsageCollector(): void {
  registerLeaderJob({
    name: USAGE_COLLECTOR_JOB,
    intervalMs: Number(process.env.USAGE_COLLECTOR_INTERVAL_MS) || USAGE_COLLECTOR_INTERVAL_MS,
    initialDelayMs: 2 * 60 * 1000,
    run: async () => {
      const r = await runUsageCollector();
      return r === 'skipped' ? 'skipped' : undefined;
    },
  });
}
