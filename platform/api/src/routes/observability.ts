/**
 * Observability views (#48): project-scoped query proxies to Prometheus, Loki,
 * Tempo and Pyroscope plus summary endpoints for the portal.
 *
 *   GET /observability/status                                       backends installed?
 *   GET /observability/fleet?since=1h                               accessible projects x health / rate / errors / p95 / alerts / SLOs
 *   GET /projects/:projectId/observability/summary?since=           RED + Apdex, incidents, errors, synthetics, SLOs
 *   GET /projects/:projectId/observability/services?since=&environment=
 *   GET /projects/:projectId/observability/endpoints?since=&service=&environment=
 *   GET /projects/:projectId/observability/red?since=&service=&environment=&step=   RED time series
 *   GET /projects/:projectId/observability/service-graph?since=&environment=
 *   GET /projects/:projectId/observability/infra?since=&environment=               pods CPU / memory / restarts
 *   GET /projects/:projectId/observability/query/prom?query=&start=&end=&step=&instant=1
 *   GET /projects/:projectId/observability/query/loki?query=|service,environment,level,search,traceId&limit=&direction=
 *   GET /projects/:projectId/observability/query/tempo?q=|service,name,environment,minDuration,maxDuration,status&limit=
 *   GET /projects/:projectId/observability/traces/:traceId
 *   GET /projects/:projectId/observability/profiles/meta?since=
 *   GET /projects/:projectId/observability/query/pyroscope?profileType=&service=&environment=&since=
 *
 * Every query is scoped server-side (lib/observability-scope.ts): the project
 * matcher is injected into every selector and cannot be overridden. Project
 * membership (viewer+) is required; platform admin/devops see every project in
 * the fleet view, other users only their own projects.
 */
import { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { AlertIncident } from '../entities/AlertIncident';
import { AlertSlo } from '../entities/AlertSlo';
import { Environment } from '../entities/Environment';
import { ErrorIssue } from '../entities/ErrorIssue';
import { Project } from '../entities/Project';
import { AuthenticatedRequest, expressAuthenticate } from '../middleware/auth';
import { isGlobalProjectAdmin, listAccessibleProjectIds, requireProjectAccess } from '../lib/project-access';
import { createLimiterStore } from '../lib/rate-limit-store';
import { getProjectStatusFeed } from '../lib/synthetic-status';
import { lokiScopeMode, observabilityEnabled, observabilityLimits } from '../lib/observability-config';
import {
  buildLogQL, buildTraceQL, escapeRegex, labelValue, PROFILE_TYPE_RE, promSelector, pyroscopeQuery, QueryScopeError, quote,
  scopeLogQL, scopePromQL, scopeTraceQL,
} from '../lib/observability-scope';
import {
  filterTraceToProject, obsRequest, parseRange, promInstant, promRange, PromResult, rangeStep, rateWindow, scalarOf,
  shapeFlamegraph, shapeLokiStreams, shapeTempoSearch, TimeRange, UpstreamError, vectorBy,
} from '../lib/observability-backends';
import { withTimeout } from '../lib/with-timeout';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALLS = 'traces_spanmetrics_calls_total';
const LATENCY = 'traces_spanmetrics_latency_bucket';
const GRAPH_TOTAL = 'traces_service_graph_request_total';
const GRAPH_FAILED = 'traces_service_graph_request_failed_total';
const SERVER_KINDS = 'span_kind=~"SPAN_KIND_SERVER|SPAN_KIND_CONSUMER"';
const ERROR_STATUS = 'status_code="STATUS_CODE_ERROR"';
/** Apdex threshold T = 0.512 s (a default Tempo span-metrics bucket); 4T = 2.048 s. */
const APDEX_T = '0.512';
const APDEX_4T = '2.048';

const DEFAULT_PROFILE_TYPES = [
  'process_cpu:cpu:nanoseconds:cpu:nanoseconds',
  'memory:alloc_space:bytes:space:bytes',
  'memory:inuse_space:bytes:space:bytes',
  'memory:alloc_objects:count:space:bytes',
  'memory:inuse_objects:count:space:bytes',
];

const limiter = rateLimit({
  windowMs: 60_000,
  limit: () => observabilityLimits().rateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req: Request) => `${(req as AuthenticatedRequest).user?.id || (req as AuthenticatedRequest).agentToken?.id || req.ip}`,
  message: { error: 'Too many observability queries. Retry in a minute.' },
  store: createLimiterStore('observability'),
});

type Handler = (req: Request, res: Response) => Promise<unknown>;

function wrap(fn: Handler) {
  return (req: Request, res: Response, _next: NextFunction) => {
    fn(req, res).catch((err: any) => {
      if (res.headersSent) return;
      if (err instanceof QueryScopeError) return res.status(400).json({ error: err.message, code: 'invalid_query' });
      if (err instanceof UpstreamError) return res.status(err.status).json({ error: err.message });
      console.error(`[observability] ${req.method} ${req.path} failed: ${err?.message || err}`);
      return res.status(500).json({ error: 'Observability query failed' });
    });
  };
}

function disabled(res: Response): boolean {
  if (observabilityEnabled()) return false;
  res.status(503).json({ error: 'Observability backends are not installed (full install profile)', code: 'observability_disabled' });
  return true;
}

/** Project access (viewer+). Responds and returns null when denied. */
async function projectFor(req: Request, res: Response): Promise<string | null> {
  const projectId = String(req.params.projectId || '');
  if (!UUID_RE.test(projectId)) { res.status(400).json({ error: 'invalid project id' }); return null; }
  const access = await requireProjectAccess(req as AuthenticatedRequest, projectId);
  if (access.ok === false) { res.status(access.status).json({ error: access.error }); return null; }
  const project = await (await getDb()).getRepository(Project).findOne({ where: { id: projectId } });
  if (!project || (project as any).deletedAt) { res.status(404).json({ error: 'Project not found' }); return null; }
  return projectId.toLowerCase();
}

function q(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (Array.isArray(v)) throw new QueryScopeError(`${name} must be given once`);
  if (v !== undefined && typeof v !== 'string') throw new QueryScopeError(`invalid ${name}`);
  return v as string | undefined;
}

function rangeOf(req: Request, defaultSince = 3600): TimeRange {
  return parseRange({ start: q(req, 'start'), end: q(req, 'end'), since: q(req, 'since') }, Date.now(), defaultSince);
}

function intParam(req: Request, name: string, def: number, max: number): number {
  const raw = q(req, name);
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new QueryScopeError(`invalid ${name}`);
  return Math.min(n, max);
}

const nanOrNull = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : v);

// ---------------------------------------------------------------------------
// Shared metric helpers (server-built, scoped PromQL)
// ---------------------------------------------------------------------------

interface Red {
  requestRate: number | null;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  apdex: number | null;
}

async function projectRed(projectId: string, range: TimeRange, filters: { service?: string | null; environment?: string | null } = {}): Promise<Red> {
  const sel = promSelector(projectId, { service: filters.service, deployment_environment: filters.environment }, [SERVER_KINDS]);
  const errSel = promSelector(projectId, { service: filters.service, deployment_environment: filters.environment }, [SERVER_KINDS, ERROR_STATUS]);
  const w = rateWindow(range);
  const t = range.end;
  const quantile = (p: string) => promInstant(`1000 * histogram_quantile(${p}, sum by (le) (rate(${LATENCY}${sel}[${w}])))`, t);
  const bucket = (le: string) => promSelector(projectId, { service: filters.service, deployment_environment: filters.environment, le }, [SERVER_KINDS]);
  const [rate, err, p50, p95, p99, apdex] = await Promise.all([
    promInstant(`sum(rate(${CALLS}${sel}[${w}]))`, t),
    promInstant(`100 * sum(rate(${CALLS}${errSel}[${w}])) / sum(rate(${CALLS}${sel}[${w}]))`, t),
    quantile('0.5'),
    quantile('0.95'),
    quantile('0.99'),
    promInstant(`(sum(rate(${LATENCY}${bucket(APDEX_T)}[${w}])) + sum(rate(${LATENCY}${bucket(APDEX_4T)}[${w}]))) / 2 / sum(rate(${LATENCY}${bucket('+Inf')}[${w}]))`, t),
  ]);
  return {
    requestRate: nanOrNull(scalarOf(rate)),
    errorRate: nanOrNull(scalarOf(err)),
    p50Ms: nanOrNull(scalarOf(p50)),
    p95Ms: nanOrNull(scalarOf(p95)),
    p99Ms: nanOrNull(scalarOf(p99)),
    apdex: nanOrNull(scalarOf(apdex)),
  };
}

/** Service names that belong to the project (from its span metrics). */
async function ownServices(projectId: string, range: TimeRange): Promise<Set<string>> {
  const res = await promInstant(`group by (service) (max_over_time(${CALLS}${promSelector(projectId)}[${rateWindow(range)}]))`, range.end);
  return new Set(res.result.map((s: any) => String(s?.metric?.service ?? '')).filter(Boolean));
}

async function projectNamespaces(projectId: string, environment: string | null): Promise<string[]> {
  const envs = await (await getDb()).getRepository(Environment).find({ where: { projectId } });
  return envs
    .filter((e: any) => !environment || String(e.name) === environment)
    .map((e: any) => String(e.namespace || ''))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Health (fleet + summary)
// ---------------------------------------------------------------------------

export type Health = 'healthy' | 'degraded' | 'critical' | 'unknown';

export interface HealthInputs {
  errorRate: number | null;
  p95Ms: number | null;
  criticalIncidents: number;
  activeIncidents: number;
  synthetics: string | null;
  slosBreaching: number;
}

export function classifyHealth(h: HealthInputs): Health {
  if (h.criticalIncidents > 0 || (h.errorRate ?? 0) >= 5 || h.synthetics === 'major_outage') return 'critical';
  if (h.activeIncidents > 0 || (h.errorRate ?? 0) >= 1 || h.slosBreaching > 0 || h.synthetics === 'partial_outage' || h.synthetics === 'degraded') return 'degraded';
  if (h.errorRate === null && h.p95Ms === null && (h.synthetics === null || h.synthetics === 'unknown')) return 'unknown';
  return 'healthy';
}

interface DbSummary {
  incidents: { active: number; critical: number };
  errors: { open: number; regressions: number };
  synthetics: string | null;
  slos: Array<{ id: string; name: string; target: number; sli: number | null; errorBudgetRemaining: number | null; breaching: boolean }>;
}

async function dbSummary(projectId: string): Promise<DbSummary> {
  const ds = await getDb();
  const safe = <T>(p: Promise<T>, fallback: T) => withTimeout(p, 5000, fallback);
  const [incidents, issues, slos, feed] = await Promise.all([
    safe(ds.getRepository(AlertIncident).find({ where: { projectId }, take: 1000 }) as Promise<any[]>, []),
    safe(ds.getRepository(ErrorIssue).find({ where: { projectId, status: 'open' }, take: 5000 }) as Promise<any[]>, []),
    safe(ds.getRepository(AlertSlo).find({ where: { projectId }, take: 100 }) as Promise<any[]>, []),
    safe(getProjectStatusFeed(projectId).then((f) => f.status as string), null as string | null),
  ]);
  const active = incidents.filter((i) => i.status && i.status !== 'resolved');
  return {
    incidents: { active: active.length, critical: active.filter((i) => i.severity === 'critical').length },
    errors: { open: issues.length, regressions: issues.filter((i) => i.regression).length },
    synthetics: feed,
    slos: slos.filter((s) => s.enabled !== false).map((s) => {
      const st = s.status || {};
      const budget = typeof st.errorBudgetRemaining === 'number' ? st.errorBudgetRemaining : null;
      return {
        id: s.id,
        name: s.name,
        target: Number(s.target),
        sli: typeof st.sli === 'number' ? st.sli : null,
        errorBudgetRemaining: budget,
        breaching: Boolean(st.alerts?.page || st.alerts?.ticket) || (budget !== null && budget < 0),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Status + fleet
// ---------------------------------------------------------------------------

router.get('/observability/status', expressAuthenticate, (_req: Request, res: Response) => {
  const limits = observabilityLimits();
  res.json({
    enabled: observabilityEnabled(),
    backends: observabilityEnabled() ? ['metrics', 'logs', 'traces', 'profiles'] : [],
    limits: { maxRangeHours: limits.maxRangeSeconds / 3600, maxLogLines: limits.maxLogLines, maxTraces: limits.maxTraces },
  });
});

router.get('/observability/fleet', expressAuthenticate, limiter, wrap(async (req, res) => {
  const auth = req as AuthenticatedRequest;
  const range = rangeOf(req);
  const limits = observabilityLimits();
  const ids = await listAccessibleProjectIds(auth.user, auth.agentToken);
  const repo = (await getDb()).getRepository(Project);
  let projects: any[];
  if (ids === null) projects = (await repo.find({ take: limits.fleetMaxProjects + 1 })) as any[];
  else projects = (await Promise.all(ids.slice(0, limits.fleetMaxProjects + 1).map((id) => repo.findOne({ where: { id } })))).filter(Boolean) as any[];
  projects = projects.filter((p) => p && !p.deletedAt && UUID_RE.test(String(p.id)));
  const truncated = projects.length > limits.fleetMaxProjects;
  projects = projects.slice(0, limits.fleetMaxProjects);
  const allowed = new Set(projects.map((p) => String(p.id).toLowerCase()));

  let rate = new Map<string, number>();
  let errors = new Map<string, number>();
  let p95 = new Map<string, number>();
  let telemetryError: string | null = null;
  if (observabilityEnabled() && projects.length) {
    // Fleet queries group by project. Non-admins get an explicit project matcher
    // (ids validated as UUIDs); results are filtered to the accessible set again.
    const scope = ids === null && isGlobalProjectAdmin(auth.user)
      ? SERVER_KINDS
      : `${SERVER_KINDS},platform_project_id=~${quote([...allowed].map(escapeRegex).join('|'))}`;
    const w = rateWindow(range);
    try {
      const [r, e, l] = await Promise.all([
        promInstant(`sum by (platform_project_id) (rate(${CALLS}{${scope}}[${w}]))`, range.end),
        promInstant(`100 * sum by (platform_project_id) (rate(${CALLS}{${scope},${ERROR_STATUS}}[${w}])) / sum by (platform_project_id) (rate(${CALLS}{${scope}}[${w}]))`, range.end),
        promInstant(`1000 * histogram_quantile(0.95, sum by (le, platform_project_id) (rate(${LATENCY}{${scope}}[${w}])))`, range.end),
      ]);
      rate = vectorBy(r, 'platform_project_id');
      errors = vectorBy(e, 'platform_project_id');
      p95 = vectorBy(l, 'platform_project_id');
    } catch (err: any) {
      telemetryError = err instanceof UpstreamError ? err.message : 'Metrics backend is unavailable';
    }
  }

  const rows = await Promise.all(projects.map(async (p) => {
    const id = String(p.id).toLowerCase();
    const db = await dbSummary(id);
    const errorRate = nanOrNull(errors.get(id));
    const p95Ms = nanOrNull(p95.get(id));
    const slosBreaching = db.slos.filter((s) => s.breaching).length;
    return {
      projectId: p.id,
      name: p.name,
      requestRate: nanOrNull(rate.get(id)),
      errorRate,
      p95Ms,
      activeAlerts: db.incidents.active,
      criticalAlerts: db.incidents.critical,
      openErrors: db.errors.open,
      synthetics: db.synthetics,
      slos: { total: db.slos.length, breaching: slosBreaching },
      health: classifyHealth({ errorRate, p95Ms, criticalIncidents: db.incidents.critical, activeIncidents: db.incidents.active, synthetics: db.synthetics, slosBreaching }),
    };
  }));
  res.json({
    telemetryEnabled: observabilityEnabled(),
    telemetryError,
    range,
    truncated,
    scope: ids === null ? 'all' : 'member',
    projects: rows.filter((r) => allowed.has(String(r.projectId).toLowerCase())),
  });
}));

// ---------------------------------------------------------------------------
// Per-project summaries
// ---------------------------------------------------------------------------

router.get('/projects/:projectId/observability/summary', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId) return;
  const range = rangeOf(req);
  const db = await dbSummary(projectId);
  let red: Red | null = null;
  let telemetryError: string | null = null;
  if (observabilityEnabled()) {
    try {
      red = await projectRed(projectId, range, { environment: labelValue(q(req, 'environment'), 'environment') });
    } catch (err: any) {
      if (err instanceof QueryScopeError) throw err;
      telemetryError = err instanceof UpstreamError ? err.message : 'Metrics backend is unavailable';
    }
  }
  const slosBreaching = db.slos.filter((s) => s.breaching).length;
  res.json({
    telemetryEnabled: observabilityEnabled(),
    telemetryError,
    range,
    red,
    ...db,
    health: classifyHealth({
      errorRate: red?.errorRate ?? null,
      p95Ms: red?.p95Ms ?? null,
      criticalIncidents: db.incidents.critical,
      activeIncidents: db.incidents.active,
      synthetics: db.synthetics,
      slosBreaching,
    }),
  });
}));

router.get('/projects/:projectId/observability/services', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req);
  const environment = labelValue(q(req, 'environment'), 'environment');
  const sel = promSelector(projectId, { deployment_environment: environment }, [SERVER_KINDS]);
  const errSel = promSelector(projectId, { deployment_environment: environment }, [SERVER_KINDS, ERROR_STATUS]);
  const w = rateWindow(range);
  const [all, rate, err, p95] = await Promise.all([
    promInstant(`group by (service) (max_over_time(${CALLS}${promSelector(projectId, { deployment_environment: environment })}[${w}]))`, range.end),
    promInstant(`sum by (service) (rate(${CALLS}${sel}[${w}]))`, range.end),
    promInstant(`100 * sum by (service) (rate(${CALLS}${errSel}[${w}])) / sum by (service) (rate(${CALLS}${sel}[${w}]))`, range.end),
    promInstant(`1000 * histogram_quantile(0.95, sum by (le, service) (rate(${LATENCY}${sel}[${w}])))`, range.end),
  ]);
  const r = vectorBy(rate, 'service');
  const e = vectorBy(err, 'service');
  const l = vectorBy(p95, 'service');
  const names = new Set<string>([...vectorBy(all, 'service').keys(), ...r.keys()]);
  names.delete('');
  res.json({
    range,
    services: [...names].sort().map((name) => ({ name, requestRate: nanOrNull(r.get(name)), errorRate: nanOrNull(e.get(name)), p95Ms: nanOrNull(l.get(name)) })),
  });
}));

router.get('/projects/:projectId/observability/endpoints', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req);
  const filters = { service: labelValue(q(req, 'service'), 'service'), deployment_environment: labelValue(q(req, 'environment'), 'environment') };
  const sel = promSelector(projectId, filters, [SERVER_KINDS]);
  const errSel = promSelector(projectId, filters, [SERVER_KINDS, ERROR_STATUS]);
  const w = rateWindow(range);
  const by = 'service, span_name';
  const [rate, err, p95] = await Promise.all([
    promInstant(`topk(100, sum by (${by}) (rate(${CALLS}${sel}[${w}])))`, range.end),
    promInstant(`100 * sum by (${by}) (rate(${CALLS}${errSel}[${w}])) / sum by (${by}) (rate(${CALLS}${sel}[${w}]))`, range.end),
    promInstant(`1000 * histogram_quantile(0.95, sum by (le, ${by}) (rate(${LATENCY}${sel}[${w}])))`, range.end),
  ]);
  const key = (m: any) => `${m?.service ?? ''}\u0000${m?.span_name ?? ''}`;
  const errs = new Map(err.result.map((s: any) => [key(s.metric), Number(s.value?.[1])]));
  const lat = new Map(p95.result.map((s: any) => [key(s.metric), Number(s.value?.[1])]));
  res.json({
    range,
    endpoints: rate.result.map((s: any) => ({
      service: String(s.metric?.service ?? ''),
      name: String(s.metric?.span_name ?? ''),
      requestRate: nanOrNull(Number(s.value?.[1])),
      errorRate: nanOrNull(errs.get(key(s.metric)) as number),
      p95Ms: nanOrNull(lat.get(key(s.metric)) as number),
    })).sort((a: any, b: any) => (b.requestRate ?? 0) - (a.requestRate ?? 0)),
  });
}));

router.get('/projects/:projectId/observability/red', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req);
  const step = rangeStep(range, q(req, 'step'));
  const filters = { service: labelValue(q(req, 'service'), 'service'), deployment_environment: labelValue(q(req, 'environment'), 'environment') };
  const sel = promSelector(projectId, filters, [SERVER_KINDS]);
  const errSel = promSelector(projectId, filters, [SERVER_KINDS, ERROR_STATUS]);
  const w = `${Math.max(60, step * 2)}s`;
  const [rate, err, p95] = await Promise.all([
    promRange(`sum(rate(${CALLS}${sel}[${w}]))`, range, step),
    promRange(`100 * sum(rate(${CALLS}${errSel}[${w}])) / sum(rate(${CALLS}${sel}[${w}]))`, range, step),
    promRange(`1000 * histogram_quantile(0.95, sum by (le) (rate(${LATENCY}${sel}[${w}])))`, range, step),
  ]);
  const points = (r: PromResult) => (r.result[0]?.values || []).map((v: any) => [Number(v[0]), nanOrNull(Number(v[1]))]);
  res.json({ range, step, requestRate: points(rate), errorRate: points(err), p95Ms: points(p95) });
}));

/** Graph node names that never identify another project's service. */
const VIRTUAL_CONNECTIONS = new Set(['virtual_node', 'database', 'messaging_system']);

router.get('/projects/:projectId/observability/service-graph', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req);
  const environment = labelValue(q(req, 'environment'), 'environment');
  const w = rateWindow(range);
  const by = 'client, server, connection_type';
  // Tempo service-graph dimensions are either unprefixed or client_/server_ prefixed
  // (enable_client_server_prefix); match any of them, always with the caller's id.
  const id = quote(projectId);
  const env = environment ? `,deployment_environment=${quote(environment)}` : '';
  const sel = (metric: string) => [
    `sum by (${by}) (rate(${metric}{platform_project_id=${id}${env}}[${w}]))`,
    `sum by (${by}) (rate(${metric}{client_platform_project_id=${id}}[${w}]))`,
    `sum by (${by}) (rate(${metric}{server_platform_project_id=${id}}[${w}]))`,
  ].join(' or ');
  const [total, failed, services] = await Promise.all([
    promInstant(sel(GRAPH_TOTAL), range.end),
    promInstant(sel(GRAPH_FAILED), range.end),
    ownServices(projectId, range),
  ]);
  const EXTERNAL = '(other project)';
  const nodeName = (name: string, conn: string) => (services.has(name) || VIRTUAL_CONNECTIONS.has(conn) ? name : EXTERNAL);
  const edges = new Map<string, { source: string; target: string; requestRate: number; failedRate: number }>();
  const add = (r: PromResult, field: 'requestRate' | 'failedRate') => {
    for (const s of r.result) {
      const conn = String(s.metric?.connection_type ?? '');
      const source = nodeName(String(s.metric?.client ?? ''), conn);
      const target = nodeName(String(s.metric?.server ?? ''), conn);
      if (source === EXTERNAL && target === EXTERNAL) continue;
      const v = Number(s.value?.[1]);
      if (!Number.isFinite(v)) continue;
      const k = `${source}\u0000${target}`;
      const e = edges.get(k) || { source, target, requestRate: 0, failedRate: 0 };
      e[field] += v;
      edges.set(k, e);
    }
  };
  add(total, 'requestRate');
  add(failed, 'failedRate');
  const nodes = new Map<string, { id: string; external: boolean; virtual: boolean }>();
  for (const s of services) nodes.set(s, { id: s, external: false, virtual: false });
  for (const e of edges.values()) {
    for (const n of [e.source, e.target]) if (!nodes.has(n)) nodes.set(n, { id: n, external: n === EXTERNAL, virtual: n !== EXTERNAL && !services.has(n) });
  }
  res.json({
    range,
    nodes: [...nodes.values()],
    edges: [...edges.values()].map((e) => ({ ...e, errorRate: e.requestRate > 0 ? (100 * e.failedRate) / e.requestRate : null })),
  });
}));

router.get('/projects/:projectId/observability/infra', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req);
  const step = rangeStep(range, q(req, 'step'));
  const environment = labelValue(q(req, 'environment'), 'environment');
  const namespaces = await projectNamespaces(projectId, environment);
  if (!namespaces.length) return res.json({ range, step, namespaces: [], cpu: [], memory: [], restarts: [] });
  // Namespaces are server-assigned (Environment rows), never client input.
  const ns = `namespace=~${quote([...new Set(namespaces)].map(escapeRegex).join('|'))}`;
  const w = `${Math.max(60, step * 2)}s`;
  const [cpu, mem, restarts] = await Promise.all([
    promRange(`sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{${ns},container!=""}[${w}]))`, range, step),
    promRange(`sum by (namespace, pod) (container_memory_working_set_bytes{${ns},container!=""})`, range, step),
    promInstant(`sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${ns}}[${rateWindow(range)}]))`, range.end),
  ]);
  const series = (r: PromResult) => r.result.map((s: any) => ({
    namespace: s.metric?.namespace,
    pod: s.metric?.pod,
    values: (s.values || []).map((v: any) => [Number(v[0]), nanOrNull(Number(v[1]))]),
  }));
  res.json({
    range,
    step,
    namespaces,
    cpu: series(cpu),
    memory: series(mem),
    restarts: restarts.result.map((s: any) => ({ namespace: s.metric?.namespace, pod: s.metric?.pod, restarts: nanOrNull(Number(s.value?.[1])) })),
  });
}));

// ---------------------------------------------------------------------------
// Query proxies
// ---------------------------------------------------------------------------

router.get('/projects/:projectId/observability/query/prom', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const query = scopePromQL(q(req, 'query'), projectId);
  const range = rangeOf(req);
  if (q(req, 'instant') === '1' || q(req, 'instant') === 'true') {
    const r = await promInstant(query, range.end);
    return res.json({ query, range, ...r });
  }
  const step = rangeStep(range, q(req, 'step'));
  const r = await promRange(query, range, step);
  res.json({ query, range, step, ...r });
}));

router.get('/projects/:projectId/observability/query/loki', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const limits = observabilityLimits();
  const raw = q(req, 'query');
  const userQuery = raw && raw.trim() ? raw : buildLogQL({
    service: labelValue(q(req, 'service'), 'service'),
    environment: labelValue(q(req, 'environment'), 'environment'),
    level: labelValue(q(req, 'level'), 'level'),
    search: labelValue(q(req, 'search'), 'search'),
    traceId: labelValue(q(req, 'traceId'), 'traceId'),
  });
  const query = scopeLogQL(userQuery, projectId, lokiScopeMode());
  const range = rangeOf(req);
  const limit = intParam(req, 'limit', 200, limits.maxLogLines);
  const direction = q(req, 'direction') === 'forward' ? 'forward' : 'backward';
  const params: Record<string, string | number> = {
    query,
    start: `${range.start}000000000`,
    end: `${range.end}000000000`,
    limit,
    direction,
  };
  // Live tail polls with a nanosecond cursor: start strictly after the last seen entry.
  const after = q(req, 'after');
  if (after) {
    if (!/^\d{1,20}$/.test(after)) throw new QueryScopeError('invalid after');
    const cursor = BigInt(after) + 1n;
    if (cursor > BigInt(params.start as string)) params.start = cursor.toString();
  }
  const data = await obsRequest({ backend: 'loki', path: '/loki/api/v1/query_range', params });
  const resultType = String(data?.data?.resultType || 'streams');
  if (resultType !== 'streams') {
    const result = Array.isArray(data?.data?.result) ? data.data.result : [];
    return res.json({ query, range, resultType, result: result.slice(0, limits.maxSeries), truncated: result.length > limits.maxSeries });
  }
  const shaped = shapeLokiStreams(data, limit);
  res.json({ query, range, resultType, ...shaped });
}));

router.get('/projects/:projectId/observability/query/tempo', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const limits = observabilityLimits();
  const raw = q(req, 'q');
  const structured = !(raw && raw.trim());
  const userQuery = structured ? buildTraceQL({
    service: labelValue(q(req, 'service'), 'service'),
    name: labelValue(q(req, 'name'), 'name'),
    environment: labelValue(q(req, 'environment'), 'environment'),
    minDuration: labelValue(q(req, 'minDuration'), 'minDuration'),
    maxDuration: labelValue(q(req, 'maxDuration'), 'maxDuration'),
    status: labelValue(q(req, 'status'), 'status'),
  }) : raw!;
  const query = scopeTraceQL(userQuery, projectId);
  const range = rangeOf(req);
  const limit = intParam(req, 'limit', 20, limits.maxTraces);
  const [data, services] = await Promise.all([
    obsRequest({ backend: 'tempo', path: '/api/search', params: { q: query, start: range.start, end: range.end, limit, spss: 5 } }),
    ownServices(projectId, range).catch(() => new Set<string>()),
  ]);
  res.json({ query, range, traces: shapeTempoSearch(data, services, limit) });
}));

router.get('/projects/:projectId/observability/traces/:traceId', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const traceId = String(req.params.traceId || '');
  if (!/^[0-9a-fA-F]{1,32}$/.test(traceId)) return res.status(400).json({ error: 'invalid trace id' });
  const data = await obsRequest({ backend: 'tempo', path: `/api/traces/${traceId.toLowerCase()}` });
  const { spans, hiddenSpans, truncated } = filterTraceToProject(data, projectId, observabilityLimits().maxTraceSpans);
  // Same answer whether the trace does not exist or belongs to another project.
  if (!spans.length) return res.status(404).json({ error: 'Trace not found' });
  res.json({ traceId: traceId.toLowerCase(), spans, hiddenSpans, truncated });
}));

router.get('/projects/:projectId/observability/profiles/meta', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req, 86_400);
  const matcher = promSelector(projectId);
  const values = (name: string) => obsRequest({
    backend: 'pyroscope',
    method: 'POST',
    path: '/querier.v1.QuerierService/LabelValues',
    headers: { 'Content-Type': 'application/json' },
    body: { name, matchers: [matcher], start: range.start * 1000, end: range.end * 1000 },
  }).then((d) => (Array.isArray(d?.names) ? d.names.map(String) : []) as string[]);
  const [services, types] = await Promise.all([values('platform_service'), values('__profile_type__').catch(() => [] as string[])]);
  const profileTypes = types.filter((t) => PROFILE_TYPE_RE.test(t));
  res.json({ range, services: services.slice(0, 500), profileTypes: profileTypes.length ? profileTypes : DEFAULT_PROFILE_TYPES });
}));

router.get('/projects/:projectId/observability/query/pyroscope', expressAuthenticate, limiter, wrap(async (req, res) => {
  const projectId = await projectFor(req, res);
  if (!projectId || disabled(res)) return;
  const range = rangeOf(req);
  const profileType = q(req, 'profileType') || DEFAULT_PROFILE_TYPES[0];
  const query = pyroscopeQuery(projectId, profileType, labelValue(q(req, 'service'), 'service'), labelValue(q(req, 'environment'), 'environment'));
  const maxNodes = intParam(req, 'maxNodes', 1024, 8192);
  const data = await obsRequest({ backend: 'pyroscope', path: '/pyroscope/render', params: { query, from: range.start, until: range.end, format: 'json', 'max-nodes': maxNodes } });
  const flame = shapeFlamegraph(data);
  res.json({ query, range, profileType, ...(flame || { flamebearer: null, metadata: null }) });
}));

export default router;
