/**
 * Usage metering API (#57):
 *   GET  /projects/:projectId/usage?from&to
 *   GET  /projects/:projectId/usage/export.csv?from&to
 *   GET  /projects/:projectId/usage/quota
 *   PUT  /projects/:projectId/usage/quota
 *   GET  /usage?from&to                 (admin/devops — all projects)
 *   GET  /usage/export.csv?from&to
 *   GET  /usage/settings
 *   PUT  /usage/settings
 */
import { Router, Request, Response, NextFunction } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { UsageDailyRollup } from '../entities/UsageDailyRollup';
import { UsageQuota } from '../entities/UsageQuota';
import { UsageSettings } from '../entities/UsageSettings';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { requireProjectAccess } from '../lib/project-access';
import {
  EMPTY_METRICS, UsageMetrics, sumRollupMetrics, utcDay,
} from '../lib/usage-metrics';
import {
  CostBreakdown, allocateServerCost, directCost, parsePrices, usageCsv,
} from '../lib/usage-cost';
import {
  emptyQuota, parseQuotaBody, quotaBars, usageAgainstQuota,
} from '../lib/usage-quota';
import {
  applyProjectResourceQuota, getOrCreateUsageSettings, loadUsagePrices,
} from '../lib/usage-collector';

const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safe(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

async function projectAccess(req: Request, res: Response, minRole: ProjectAccessRole): Promise<boolean> {
  const projectId = String(req.params.projectId || '');
  if (!uuid.test(projectId)) {
    res.status(400).json({ error: 'invalid project id' });
    return false;
  }
  const access = await requireProjectAccess(req as AuthenticatedRequest, projectId, minRole);
  if (access.ok === false) {
    res.status(access.status).json({ error: access.error });
    return false;
  }
  return true;
}

function parseRange(q: Record<string, unknown>, now = new Date()): { from: string; to: string; days: number } {
  const today = utcDay(now);
  const monthStart = today.slice(0, 8) + '01';
  const from = typeof q.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? q.from : monthStart;
  const to = typeof q.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? q.to : today;
  if (from > to) throw Object.assign(new Error('from must be on or before to'), { status: 400 });
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
  if (days > 366) throw Object.assign(new Error('range cannot exceed 366 days'), { status: 400 });
  return { from, to, days };
}

function rowMetrics(r: UsageDailyRollup): UsageMetrics {
  return {
    cpuCoreHours: Number(r.cpuCoreHours) || 0,
    memoryGbHours: Number(r.memoryGbHours) || 0,
    pvcStorageGb: Number(r.pvcStorageGb) || 0,
    objectStorageGb: Number(r.objectStorageGb) || 0,
    ingressBandwidthGb: Number(r.ingressBandwidthGb) || 0,
    buildMinutes: Number(r.buildMinutes) || 0,
  };
}

function publicSettings(s: UsageSettings) {
  return {
    perCoreHour: s.perCoreHour,
    perGbHourMemory: s.perGbHourMemory,
    perGbMonthStorage: s.perGbMonthStorage,
    perGbBandwidth: s.perGbBandwidth,
    perBuildMinute: s.perBuildMinute,
    monthlyServerCost: s.monthlyServerCost,
    currency: s.currency,
  };
}

function publicQuota(q: UsageQuota | null, projectId: string) {
  if (!q) return emptyQuota(projectId);
  return {
    projectId,
    cpuCoreHours: q.cpuCoreHours,
    memoryGbHours: q.memoryGbHours,
    storageGb: q.storageGb,
    bandwidthGb: q.bandwidthGb,
    buildMinutes: q.buildMinutes,
    resourceQuota: q.resourceQuota,
    alertsEnabled: q.alertsEnabled,
  };
}

async function loadRollups(projectId: string | null, from: string, to: string): Promise<UsageDailyRollup[]> {
  const ds = await getDb();
  const repo = ds.getRepository(UsageDailyRollup);
  const rows = projectId
    ? await repo.find({ where: { projectId } as any })
    : await repo.find();
  return rows
    .filter((r) => {
      const d = String(r.day).slice(0, 10);
      return d >= from && d <= to;
    })
    .sort((a, b) => String(a.day).localeCompare(String(b.day)) || String(a.environmentName || '').localeCompare(String(b.environmentName || '')));
}

function summarize(
  rows: UsageDailyRollup[],
  prices: ReturnType<typeof parsePrices>,
  dayCount: number,
): { daily: any[]; totals: UsageMetrics; cost: CostBreakdown } {
  const dailyMap = new Map<string, UsageMetrics>();
  for (const r of rows) {
    const day = String(r.day).slice(0, 10);
    const prev = dailyMap.get(day) || { ...EMPTY_METRICS };
    dailyMap.set(day, sumRollupMetrics([prev, rowMetrics(r)]));
  }
  const daily = [...dailyMap.entries()].map(([day, metrics]) => ({
    day,
    metrics,
    cost: directCost(metrics, prices, 1),
  }));
  // Month totals: sum compute/bandwidth/build; storage uses max daily footprint.
  const totals = sumRollupMetrics(
    daily.map((d) => d.metrics),
    { storageMode: 'max' },
  );
  // Cost over the period: sum of daily direct costs (storage already daily-priced).
  const costSum = daily.reduce(
    (acc, d) => ({
      cpu: acc.cpu + d.cost.cpu,
      memory: acc.memory + d.cost.memory,
      storage: acc.storage + d.cost.storage,
      bandwidth: acc.bandwidth + d.cost.bandwidth,
      build: acc.build + d.cost.build,
      serverShare: 0,
      total: acc.total + d.cost.total,
    }),
    { cpu: 0, memory: 0, storage: 0, bandwidth: 0, build: 0, serverShare: 0, total: 0 },
  );
  void dayCount;
  return {
    daily,
    totals,
    cost: {
      cpu: Number(costSum.cpu.toFixed(4)),
      memory: Number(costSum.memory.toFixed(4)),
      storage: Number(costSum.storage.toFixed(4)),
      bandwidth: Number(costSum.bandwidth.toFixed(4)),
      build: Number(costSum.build.toFixed(4)),
      serverShare: 0,
      total: Number(costSum.total.toFixed(4)),
    },
  };
}

// ---------------------------------------------------------------------------
// Project usage
// ---------------------------------------------------------------------------

router.get('/projects/:projectId/usage', expressAuthenticate, safe(async (req, res) => {
  if (!(await projectAccess(req, res, ProjectAccessRole.VIEWER))) return;
  let range: { from: string; to: string; days: number };
  try { range = parseRange(req.query as any); } catch (e: any) {
    return void res.status(e.status || 400).json({ error: e.message });
  }
  const projectId = req.params.projectId;
  const prices = await loadUsagePrices();
  const rows = await loadRollups(projectId, range.from, range.to);
  const { daily, totals, cost } = summarize(rows, prices, range.days);
  const withShare = allocateServerCost([{ metrics: totals, cost }], prices, range.days)[0];

  const ds = await getDb();
  const quotaRow = await ds.getRepository(UsageQuota).findOne({ where: { projectId } });
  const quota = publicQuota(quotaRow, projectId);
  const bars = quotaBars(usageAgainstQuota(totals), quota);

  res.json({
    projectId,
    from: range.from,
    to: range.to,
    currency: prices.currency,
    prices,
    daily,
    totals: withShare.metrics,
    cost: withShare.cost,
    environments: rows.map((r) => ({
      day: String(r.day).slice(0, 10),
      environmentId: r.environmentId,
      environmentName: r.environmentName,
      namespace: r.namespace,
      metrics: rowMetrics(r),
      cost: directCost(rowMetrics(r), prices, 1),
    })),
    quota,
    quotaBars: bars,
  });
}));

router.get('/projects/:projectId/usage/export.csv', expressAuthenticate, safe(async (req, res) => {
  if (!(await projectAccess(req, res, ProjectAccessRole.VIEWER))) return;
  let range: { from: string; to: string; days: number };
  try { range = parseRange(req.query as any); } catch (e: any) {
    return void res.status(e.status || 400).json({ error: e.message });
  }
  const projectId = req.params.projectId;
  const ds = await getDb();
  const project = await ds.getRepository(Project).findOne({ where: { id: projectId } });
  const prices = await loadUsagePrices();
  const rows = await loadRollups(projectId, range.from, range.to);
  const csv = usageCsv(rows.map((r) => ({
    day: String(r.day).slice(0, 10),
    projectId,
    projectName: project?.name,
    environmentName: r.environmentName,
    namespace: r.namespace,
    metrics: rowMetrics(r),
    cost: directCost(rowMetrics(r), prices, 1),
  })));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usage-${projectId}-${range.from}-${range.to}.csv"`);
  res.send(csv);
}));

router.get('/projects/:projectId/usage/quota', expressAuthenticate, safe(async (req, res) => {
  if (!(await projectAccess(req, res, ProjectAccessRole.VIEWER))) return;
  const ds = await getDb();
  const row = await ds.getRepository(UsageQuota).findOne({ where: { projectId: req.params.projectId } });
  res.json(publicQuota(row, req.params.projectId));
}));

router.put('/projects/:projectId/usage/quota', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS, UserRole.TECH_LEAD]), safe(async (req, res) => {
  if (!(await projectAccess(req, res, ProjectAccessRole.DEVOPS))) return;
  let patch: ReturnType<typeof parseQuotaBody>;
  try { patch = parseQuotaBody(req.body); } catch (e: any) {
    return void res.status(400).json({ error: e.message });
  }
  const ds = await getDb();
  const repo = ds.getRepository(UsageQuota);
  let row = await repo.findOne({ where: { projectId: req.params.projectId } });
  if (!row) row = repo.create({ projectId: req.params.projectId, alertsEnabled: true });
  Object.assign(row, patch);
  const saved = await repo.save(row);
  if ('resourceQuota' in patch) {
    // Best-effort: apply to live namespaces; failures are logged, not fatal to the save.
    void applyProjectResourceQuota(req.params.projectId, saved.resourceQuota);
  }
  res.json(publicQuota(saved, req.params.projectId));
}));

// ---------------------------------------------------------------------------
// Fleet / admin
// ---------------------------------------------------------------------------

router.get('/usage', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), safe(async (req, res) => {
  let range: { from: string; to: string; days: number };
  try { range = parseRange(req.query as any); } catch (e: any) {
    return void res.status(e.status || 400).json({ error: e.message });
  }
  const prices = await loadUsagePrices();
  const ds = await getDb();
  const projects = await ds.getRepository(Project).find({ where: { isActive: true } as any });
  const rows = await loadRollups(null, range.from, range.to);
  const byProject = new Map<string, UsageDailyRollup[]>();
  for (const r of rows) {
    const list = byProject.get(r.projectId) || [];
    list.push(r);
    byProject.set(r.projectId, list);
  }
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  let projectRows = [...byProject.entries()].map(([projectId, list]) => {
    const { totals, cost, daily } = summarize(list, prices, range.days);
    return {
      projectId,
      projectName: nameById.get(projectId) || projectId,
      metrics: totals,
      cost,
      days: daily.length,
    };
  });
  // Include active projects with no rollups yet.
  for (const p of projects) {
    if (!byProject.has(p.id)) {
      projectRows.push({
        projectId: p.id,
        projectName: p.name,
        metrics: { ...EMPTY_METRICS },
        cost: directCost(EMPTY_METRICS, prices, 0),
        days: 0,
      });
    }
  }
  projectRows = allocateServerCost(
    projectRows.map((p) => ({ ...p, metrics: p.metrics, cost: p.cost })),
    prices,
    range.days,
  ).map((p) => ({
    projectId: p.projectId,
    projectName: p.projectName,
    metrics: p.metrics,
    cost: p.cost,
    days: p.days,
  }));
  projectRows.sort((a, b) => b.cost.total - a.cost.total);

  const fleetTotals = sumRollupMetrics(
    projectRows.map((p) => p.metrics),
    { storageMode: 'sum' },
  );
  const fleetCost = projectRows.reduce(
    (acc, p) => ({
      cpu: acc.cpu + p.cost.cpu,
      memory: acc.memory + p.cost.memory,
      storage: acc.storage + p.cost.storage,
      bandwidth: acc.bandwidth + p.cost.bandwidth,
      build: acc.build + p.cost.build,
      serverShare: acc.serverShare + p.cost.serverShare,
      total: acc.total + p.cost.total,
    }),
    { cpu: 0, memory: 0, storage: 0, bandwidth: 0, build: 0, serverShare: 0, total: 0 },
  );

  res.json({
    from: range.from,
    to: range.to,
    currency: prices.currency,
    prices,
    projects: projectRows,
    totals: fleetTotals,
    cost: {
      cpu: Number(fleetCost.cpu.toFixed(4)),
      memory: Number(fleetCost.memory.toFixed(4)),
      storage: Number(fleetCost.storage.toFixed(4)),
      bandwidth: Number(fleetCost.bandwidth.toFixed(4)),
      build: Number(fleetCost.build.toFixed(4)),
      serverShare: Number(fleetCost.serverShare.toFixed(4)),
      total: Number(fleetCost.total.toFixed(4)),
    },
  });
}));

router.get('/usage/export.csv', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), safe(async (req, res) => {
  let range: { from: string; to: string; days: number };
  try { range = parseRange(req.query as any); } catch (e: any) {
    return void res.status(e.status || 400).json({ error: e.message });
  }
  const prices = await loadUsagePrices();
  const ds = await getDb();
  const projects = await ds.getRepository(Project).find();
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const rows = await loadRollups(null, range.from, range.to);
  const csv = usageCsv(rows.map((r) => ({
    day: String(r.day).slice(0, 10),
    projectId: r.projectId,
    projectName: nameById.get(r.projectId),
    environmentName: r.environmentName,
    namespace: r.namespace,
    metrics: rowMetrics(r),
    cost: directCost(rowMetrics(r), prices, 1),
  })));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="usage-all-${range.from}-${range.to}.csv"`);
  res.send(csv);
}));

router.get('/usage/settings', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), safe(async (_req, res) => {
  const s = await getOrCreateUsageSettings();
  res.json(publicSettings(s));
}));

router.put('/usage/settings', expressAuthenticate, expressRequireRole([UserRole.ADMIN, UserRole.DEVOPS]), safe(async (req, res) => {
  const prices = parsePrices({
    perCoreHour: req.body?.perCoreHour,
    perGbHourMemory: req.body?.perGbHourMemory,
    perGbMonthStorage: req.body?.perGbMonthStorage,
    perGbBandwidth: req.body?.perGbBandwidth,
    perBuildMinute: req.body?.perBuildMinute,
    monthlyServerCost: req.body?.monthlyServerCost,
    currency: req.body?.currency,
  });
  const ds = await getDb();
  const repo = ds.getRepository(UsageSettings);
  let row = await repo.findOne({ where: {} as any });
  if (!row) row = repo.create(prices);
  else Object.assign(row, prices);
  const saved = await repo.save(row);
  res.json(publicSettings(saved));
}));

export default router;
