/**
 * Pure rule generation and evaluation math for alerting (#43):
 *  - monitor -> PromQL / LogQL expression (metric, log, trace span metrics, namespace resources)
 *  - PrometheusRule rendering (one object per project, every rule labelled `project`)
 *  - Loki ruler rule groups for log monitors
 *  - SLOs -> Sloth-style recording rules + multi-window multi-burn-rate alerts
 *  - burn-rate / error-budget math and the API evaluator's monitor state machine
 */
import YAML from 'yaml';

export const OPERATORS = ['>', '<', '>=', '<=', '==', '!='] as const;
export type Operator = (typeof OPERATORS)[number];
export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export const SEVERITY_RANK: Record<string, number> = { info: 1, warning: 2, critical: 3 };
export const TRACE_SIGNALS = ['error_rate', 'latency_p95', 'request_rate'] as const;
export const RESOURCES = ['cpu', 'memory'] as const;
/** Tempo span-metrics latency histogram boundaries (seconds); latency SLO thresholds must be one of them. */
export const TEMPO_LATENCY_BUCKETS_MS = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
export const MAX_QUERY_LENGTH = 4000;

export interface MonitorLike {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  query?: string | null;
  params?: Record<string, any> | null;
  operator: string;
  threshold: number;
  forSeconds: number;
  severity: string;
  labels?: Record<string, string> | null;
  description?: string | null;
  enabled?: boolean;
}

export interface SloLike {
  id: string;
  projectId: string;
  name: string;
  sliType: string;
  errorQuery?: string | null;
  totalQuery?: string | null;
  params?: Record<string, any> | null;
  target: number;
  windowDays: number;
  enabled?: boolean;
}

export interface RuleContext {
  /** Kubernetes namespaces of the project's environments (resource monitors). */
  namespaces: string[];
  /** Namespace the PrometheusRule lives in; added as a rule label for Alertmanager routing. */
  ruleNamespace: string;
  /** Portal base URL for links (may be empty). */
  portal?: string;
}

/** Escape a PromQL / LogQL label value for use inside double quotes. */
export function escapeLabelValue(v: string): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeRegex(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortId(id: string): string {
  return String(id).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

export function validateQuery(q: unknown, field = 'query'): string {
  if (typeof q !== 'string' || !q.trim()) throw new Error(`${field} is required`);
  if (q.length > MAX_QUERY_LENGTH) throw new Error(`${field} is too long (max ${MAX_QUERY_LENGTH} characters)`);
  if (/[\u0000]/.test(q)) throw new Error(`${field} contains invalid characters`);
  return q.trim();
}

/** `5m`, `1h`, `30s`, `1d`. */
export function durationString(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return '0s';
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Monitor expressions
// ---------------------------------------------------------------------------

function spanSelector(projectId: string, params: Record<string, any>, extra = ''): string {
  const parts = [`platform_project_id="${escapeLabelValue(projectId)}"`];
  if (params.service) parts.push(`service="${escapeLabelValue(params.service)}"`);
  if (params.environment) parts.push(`deployment_environment="${escapeLabelValue(params.environment)}"`);
  if (extra) parts.push(extra);
  return `{${parts.join(',')}}`;
}

function namespaceMatcher(namespaces: string[]): string {
  const ns = [...new Set(namespaces.filter(Boolean))].sort();
  // Matches nothing when the project has no namespace yet.
  return ns.length ? `namespace=~"${escapeLabelValue(ns.map(escapeRegex).join('|'))}"` : 'namespace="__platform_none__"';
}

export interface MonitorExpr {
  engine: 'prometheus' | 'loki';
  /** Value expression (no comparison). */
  expr: string;
}

/** The value expression a monitor compares against its threshold. Throws on invalid monitors. */
export function monitorExpr(m: MonitorLike, ctx: Pick<RuleContext, 'namespaces'>): MonitorExpr {
  const params = m.params || {};
  switch (m.kind) {
    case 'metric':
      return { engine: 'prometheus', expr: `(${validateQuery(m.query)})` };
    case 'log':
      return { engine: 'loki', expr: `(${validateQuery(m.query)})` };
    case 'trace': {
      const w = '5m';
      switch (params.signal) {
        case 'error_rate':
          return {
            engine: 'prometheus',
            expr: `(100 * sum(rate(traces_spanmetrics_calls_total${spanSelector(m.projectId, params, 'status_code="STATUS_CODE_ERROR"')}[${w}])) / sum(rate(traces_spanmetrics_calls_total${spanSelector(m.projectId, params)}[${w}])))`,
          };
        case 'latency_p95':
          return {
            engine: 'prometheus',
            expr: `(1000 * histogram_quantile(0.95, sum by (le) (rate(traces_spanmetrics_latency_bucket${spanSelector(m.projectId, params)}[${w}]))))`,
          };
        case 'request_rate':
          return { engine: 'prometheus', expr: `sum(rate(traces_spanmetrics_calls_total${spanSelector(m.projectId, params)}[${w}]))` };
        default:
          throw new Error(`trace monitors need params.signal: ${TRACE_SIGNALS.join(', ')}`);
      }
    }
    case 'resource': {
      const ns = namespaceMatcher(ctx.namespaces);
      switch (params.resource) {
        case 'cpu':
          return {
            engine: 'prometheus',
            expr: `(100 * sum(rate(container_cpu_usage_seconds_total{${ns},container!=""}[5m])) / sum(kube_pod_container_resource_limits{${ns},resource="cpu"}))`,
          };
        case 'memory':
          return {
            engine: 'prometheus',
            expr: `(100 * sum(container_memory_working_set_bytes{${ns},container!=""}) / sum(kube_pod_container_resource_limits{${ns},resource="memory"}))`,
          };
        default:
          throw new Error(`resource monitors need params.resource: ${RESOURCES.join(', ')}`);
      }
    }
    default:
      throw new Error(`unknown monitor kind ${m.kind}`);
  }
}

export function alertExpr(m: MonitorLike, ctx: Pick<RuleContext, 'namespaces'>): MonitorExpr {
  if (!OPERATORS.includes(m.operator as Operator)) throw new Error(`operator must be one of ${OPERATORS.join(' ')}`);
  if (!Number.isFinite(Number(m.threshold))) throw new Error('threshold must be a number');
  const e = monitorExpr(m, ctx);
  return { engine: e.engine, expr: `${e.expr} ${m.operator} ${Number(m.threshold)}` };
}

export function monitorAlertName(m: Pick<MonitorLike, 'id'>): string {
  return `PlatformMonitor_${shortId(m.id)}`;
}

export function monitorDedupeKey(id: string): string {
  return `monitor:${id}`;
}

export function sloDedupeKey(id: string, alert: 'page' | 'ticket'): string {
  return `slo:${id}:${alert}`;
}

function portalLink(ctx: Partial<RuleContext>, projectId: string, tab: string): string {
  return `${ctx.portal || ''}/alerting?projectId=${encodeURIComponent(projectId)}&tab=${tab}`;
}

function monitorRule(m: MonitorLike, ctx: RuleContext) {
  const { expr } = alertExpr(m, ctx);
  return {
    alert: monitorAlertName(m),
    expr,
    for: durationString(m.forSeconds || 0),
    labels: {
      ...sanitizeLabels(m.labels || {}),
      project: m.projectId,
      namespace: ctx.ruleNamespace,
      severity: m.severity,
      platform_source: 'monitor',
      platform_monitor_id: m.id,
    },
    annotations: {
      summary: m.name,
      description: m.description || `${m.name}: value {{ $value }} ${m.operator} ${m.threshold}`,
      platform_url: portalLink(ctx, m.projectId, 'monitors'),
    },
  };
}

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const RESERVED_LABELS = new Set(['project', 'namespace', 'severity', 'alertname']);

/** User labels: valid Prometheus names, no reserved/platform_ names, string values, at most 20. */
export function sanitizeLabels(labels: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels || {}).slice(0, 20)) {
    if (!LABEL_NAME.test(k) || RESERVED_LABELS.has(k) || k.startsWith('platform_') || k.startsWith('__')) continue;
    if (v === undefined || v === null) continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SLOs (Sloth-style)
// ---------------------------------------------------------------------------

export const SLO_WINDOWS = ['5m', '30m', '1h', '2h', '6h', '1d', '3d'] as const;
export type SloWindow = (typeof SLO_WINDOWS)[number];

export function errorBudget(targetPercent: number): number {
  // Rounded so 99.9 gives 0.001, not 0.0010000000000000009, in generated rules.
  return Number((1 - targetPercent / 100).toPrecision(12));
}

export function burnRate(errorRatio: number, targetPercent: number): number {
  const eb = errorBudget(targetPercent);
  return eb > 0 ? errorRatio / eb : Infinity;
}

/** Fraction of the error budget left for the SLO period (1 = untouched, <0 = overspent). */
export function errorBudgetRemaining(periodErrorRatio: number, targetPercent: number): number {
  const eb = errorBudget(targetPercent);
  return eb > 0 ? 1 - periodErrorRatio / eb : 0;
}

export interface BurnWindow {
  long: SloWindow;
  short: SloWindow;
  factor: number;
}

/**
 * Google SRE workbook multiwindow, multi-burn-rate alerts. Budget consumption per alert
 * window: page = 2% in 1h or 5% in 6h, ticket = 10% in 1d or 10% in 3d. Factors scale with
 * the SLO period (14.4 / 6 / 3 / 1 for 30 days).
 */
export function burnWindows(windowDays: number): { page: BurnWindow[]; ticket: BurnWindow[] } {
  const hours = windowDays * 24;
  const f = (budget: number, windowHours: number) => Number(((budget * hours) / windowHours).toFixed(4));
  return {
    page: [
      { long: '1h', short: '5m', factor: f(0.02, 1) },
      { long: '6h', short: '30m', factor: f(0.05, 6) },
    ],
    ticket: [
      { long: '1d', short: '2h', factor: f(0.1, 24) },
      { long: '3d', short: '6h', factor: f(0.1, 72) },
    ],
  };
}

export type ErrorRatios = Partial<Record<SloWindow, number | null>>;

/** API evaluator: which burn-rate alerts fire for the given windowed error ratios. */
export function evaluateBurnAlerts(ratios: ErrorRatios, targetPercent: number, windowDays: number): { page: boolean; ticket: boolean; burnRates: Partial<Record<SloWindow, number>> } {
  const eb = errorBudget(targetPercent);
  const burnRates: Partial<Record<SloWindow, number>> = {};
  for (const w of SLO_WINDOWS) {
    const r = ratios[w];
    if (typeof r === 'number' && Number.isFinite(r)) burnRates[w] = eb > 0 ? r / eb : Infinity;
  }
  const hit = (bw: BurnWindow) => (burnRates[bw.long] ?? -1) > bw.factor && (burnRates[bw.short] ?? -1) > bw.factor;
  const { page, ticket } = burnWindows(windowDays);
  return { page: page.some(hit), ticket: ticket.some(hit), burnRates };
}

export function validateSlo(s: SloLike): void {
  if (!(Number(s.target) > 0 && Number(s.target) < 100)) throw new Error('target must be a percentage between 0 and 100 (exclusive)');
  if (!Number.isInteger(Number(s.windowDays)) || s.windowDays < 1 || s.windowDays > 90) throw new Error('windowDays must be 1..90');
  const params = s.params || {};
  switch (s.sliType) {
    case 'ratio':
      for (const [k, q] of [['errorQuery', s.errorQuery], ['totalQuery', s.totalQuery]] as const) {
        const v = validateQuery(q, k);
        if (!v.includes('$window')) throw new Error(`${k} must use $window as its range, e.g. rate(x[$window])`);
      }
      return;
    case 'availability':
      return;
    case 'latency':
      if (!TEMPO_LATENCY_BUCKETS_MS.includes(Number(params.latencyMs))) {
        throw new Error(`params.latencyMs must be a span-metrics bucket boundary: ${TEMPO_LATENCY_BUCKETS_MS.join(', ')}`);
      }
      return;
    default:
      throw new Error('sliType must be ratio, availability or latency');
  }
}

/** Raw SLI error ratio over `window` (no recording rules; used by the API evaluator and recordings). */
export function sloErrorRatioExpr(s: SloLike, window: string): string {
  const params = s.params || {};
  switch (s.sliType) {
    case 'ratio':
      return `(${String(s.errorQuery).replace(/\$window/g, window)}) / (${String(s.totalQuery).replace(/\$window/g, window)})`;
    case 'availability':
      return `(sum(rate(traces_spanmetrics_calls_total${spanSelector(s.projectId, params, 'status_code="STATUS_CODE_ERROR"')}[${window}])) / sum(rate(traces_spanmetrics_calls_total${spanSelector(s.projectId, params)}[${window}])))`;
    case 'latency': {
      const le = String(Number(params.latencyMs) / 1000);
      return `(1 - (sum(rate(traces_spanmetrics_latency_bucket${spanSelector(s.projectId, params, `le="${le}"`)}[${window}])) / sum(rate(traces_spanmetrics_latency_count${spanSelector(s.projectId, params)}[${window}]))))`;
    }
    default:
      throw new Error(`unknown sliType ${s.sliType}`);
  }
}

export function sloRecordName(window: string): string {
  return `slo:sli_error:ratio_rate${window}`;
}

/** Recording rules + burn-rate alerts for one SLO (one rule group). */
export function sloRuleGroup(s: SloLike, ctx: RuleContext) {
  validateSlo(s);
  const sel = `{platform_slo_id="${escapeLabelValue(s.id)}"}`;
  const base = { project: s.projectId, platform_slo_id: s.id };
  const period = `${s.windowDays}d`;
  const eb = errorBudget(s.target);
  const rules: any[] = SLO_WINDOWS.map((w) => ({ record: sloRecordName(w), expr: sloErrorRatioExpr(s, w), labels: base }));
  rules.push(
    { record: sloRecordName(period), expr: `avg_over_time(${sloRecordName('5m')}${sel}[${period}])`, labels: base },
    { record: 'slo:objective:ratio', expr: `vector(${s.target / 100})`, labels: base },
    { record: 'slo:error_budget:ratio', expr: `vector(${eb})`, labels: base },
  );
  const windows = burnWindows(s.windowDays);
  const cond = (bws: BurnWindow[]) => bws
    .map((bw) => `(${sloRecordName(bw.long)}${sel} > (${bw.factor} * ${eb}) and ${sloRecordName(bw.short)}${sel} > (${bw.factor} * ${eb}))`)
    .join(' or ');
  for (const [alert, severity] of [['page', 'critical'], ['ticket', 'warning']] as const) {
    rules.push({
      alert: `PlatformSLO_${shortId(s.id)}_${alert}`,
      expr: cond(windows[alert]),
      labels: {
        ...base,
        namespace: ctx.ruleNamespace,
        severity,
        platform_source: 'slo',
        platform_slo_alert: alert,
      },
      annotations: {
        summary: `${s.name}: error budget burn rate is too high (${alert})`,
        description: `SLO ${s.name} (${s.target}% over ${period}) is burning its error budget fast enough to exhaust it early.`,
        platform_url: portalLink(ctx, s.projectId, 'slos'),
      },
    });
  }
  return { name: `slo-${shortId(s.id)}`, interval: '1m', rules };
}

// ---------------------------------------------------------------------------
// Kubernetes objects
// ---------------------------------------------------------------------------

export function prometheusRuleName(projectId: string): string {
  return `platform-alerts-${String(projectId).toLowerCase().replace(/[^a-z0-9-]/g, '')}`.slice(0, 253);
}

export interface RenderResult {
  object: any;
  errors: { id: string; error: string }[];
}

/**
 * One PrometheusRule per project: Prometheus-evaluated monitors (everything except log
 * monitors) and every SLO. Invalid entries are skipped and reported, never break the group.
 */
export function renderPrometheusRule(projectId: string, monitors: MonitorLike[], slos: SloLike[], ctx: RuleContext): RenderResult {
  const errors: { id: string; error: string }[] = [];
  const monitorRules: any[] = [];
  for (const m of monitors) {
    if (m.enabled === false || m.projectId !== projectId || m.kind === 'log') continue;
    try {
      monitorRules.push(monitorRule(m, ctx));
    } catch (err: any) {
      errors.push({ id: m.id, error: err.message });
    }
  }
  const groups: any[] = [];
  if (monitorRules.length) groups.push({ name: 'monitors', interval: '1m', rules: monitorRules });
  for (const s of slos) {
    if (s.enabled === false || s.projectId !== projectId) continue;
    try {
      groups.push(sloRuleGroup(s, ctx));
    } catch (err: any) {
      errors.push({ id: s.id, error: err.message });
    }
  }
  return {
    object: {
      apiVersion: 'monitoring.coreos.com/v1',
      kind: 'PrometheusRule',
      metadata: {
        name: prometheusRuleName(projectId),
        namespace: ctx.ruleNamespace,
        labels: { release: 'kube-prometheus', 'app.kubernetes.io/managed-by': 'platform-api', 'platform.io/project': projectId },
      },
      spec: { groups },
    },
    errors,
  };
}

/**
 * Per-project Alertmanager route (AlertmanagerConfig, monitoring.coreos.com/v1alpha1): alerts
 * with `project=<id>` go to the platform API receiver, which applies silences, dedupe,
 * escalation and delivers to the project's channels. Channel secrets never leave the API.
 */
export function renderAlertmanagerConfig(projectId: string, opts: { namespace: string; receiverUrl: string; tokenSecret: string }) {
  return {
    apiVersion: 'monitoring.coreos.com/v1alpha1',
    kind: 'AlertmanagerConfig',
    metadata: {
      name: prometheusRuleName(projectId),
      namespace: opts.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'platform-api', 'platform.io/project': projectId },
    },
    spec: {
      route: {
        receiver: 'platform-api',
        matchers: [{ name: 'project', value: projectId, matchType: '=' }],
        groupBy: ['alertname', 'project', 'platform_monitor_id', 'platform_slo_id'],
        groupWait: '30s',
        groupInterval: '5m',
        repeatInterval: '4h',
      },
      receivers: [{
        name: 'platform-api',
        webhookConfigs: [{
          url: opts.receiverUrl,
          sendResolved: true,
          httpConfig: { authorization: { type: 'Bearer', credentials: { name: opts.tokenSecret, key: 'token' } } },
        }],
      }],
    },
  };
}

/** Loki ruler rule group (YAML body for POST /loki/api/v1/rules/<namespace>). */
export function renderLokiRuleGroup(projectId: string, monitors: MonitorLike[], ctx: Pick<RuleContext, 'ruleNamespace' | 'portal'>): { name: string; yaml: string; count: number } {
  const rules = monitors
    .filter((m) => m.enabled !== false && m.kind === 'log' && m.projectId === projectId)
    .map((m) => monitorRule(m, { ...ctx, namespaces: [] }));
  const group = { name: `platform-${projectId}`, interval: '1m', rules };
  return { name: group.name, yaml: YAML.stringify(group), count: rules.length };
}

// ---------------------------------------------------------------------------
// API evaluator
// ---------------------------------------------------------------------------

export function compare(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    default: return false;
  }
}

/** Any series breaching = breached; the reported value is the first breaching (or first) sample. */
export function evaluateSamples(samples: number[], op: string, threshold: number): { breached: boolean; value: number | null } {
  const valid = samples.filter((v) => Number.isFinite(v));
  const hit = valid.find((v) => compare(v, op, threshold));
  if (hit !== undefined) return { breached: true, value: hit };
  return { breached: false, value: valid.length ? valid[0] : null };
}

export interface MonitorState {
  state: string;
  pendingSince: Date | null;
}

/** Prometheus-like `for` handling: ok -> pending -> firing; any non-breach resolves. */
export function nextMonitorState(prev: MonitorState, breached: boolean, now: Date, forSeconds: number): MonitorState & { transition: 'firing' | 'resolved' | null } {
  if (!breached) {
    return { state: 'ok', pendingSince: null, transition: prev.state === 'firing' ? 'resolved' : null };
  }
  if (prev.state === 'firing') return { state: 'firing', pendingSince: prev.pendingSince, transition: null };
  const since = prev.state === 'pending' && prev.pendingSince ? prev.pendingSince : now;
  if (now.getTime() - since.getTime() >= Math.max(0, forSeconds) * 1000) {
    return { state: 'firing', pendingSince: since, transition: 'firing' };
  }
  return { state: 'pending', pendingSince: since, transition: null };
}

// ---------------------------------------------------------------------------
// Legacy `alerts` rows
// ---------------------------------------------------------------------------

/** Same mapping as the 1798000000043 migration, for rows created through the legacy API. */
export function legacyAlertToMonitor(a: { id: string; projectId: string; type?: string; severity?: string; config?: any; isEnabled?: boolean }) {
  const metric = String(a.config?.metric || a.type || '');
  const map: Record<string, { kind: string; params: Record<string, string> }> = {
    cpu: { kind: 'resource', params: { resource: 'cpu' } },
    cpu_high: { kind: 'resource', params: { resource: 'cpu' } },
    memory: { kind: 'resource', params: { resource: 'memory' } },
    memory_high: { kind: 'resource', params: { resource: 'memory' } },
    latency: { kind: 'trace', params: { signal: 'latency_p95' } },
    errorRate: { kind: 'trace', params: { signal: 'error_rate' } },
    error_rate: { kind: 'trace', params: { signal: 'error_rate' } },
  };
  const known = map[metric];
  const op = OPERATORS.includes(a.config?.operator) ? a.config.operator : '>';
  const threshold = Number(a.config?.threshold);
  return {
    projectId: a.projectId,
    name: `Legacy: ${metric}`.slice(0, 150),
    kind: known?.kind || 'resource',
    params: known?.params || { resource: metric },
    operator: op,
    threshold: Number.isFinite(threshold) ? threshold : 0,
    forSeconds: 300,
    severity: (SEVERITIES as readonly string[]).includes(String(a.severity)) ? String(a.severity) : 'warning',
    enabled: a.isEnabled !== false && !!known,
    legacyAlertId: a.id,
    description: 'Mirrors a rule of the legacy /api/alerts API (#43).',
  };
}
