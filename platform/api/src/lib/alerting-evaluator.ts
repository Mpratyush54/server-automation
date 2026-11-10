/**
 * API-side rule evaluation (#43) for installs without the Prometheus ruler path
 * (ALERTING_MODE=api: standard/minimal profiles) and for log monitors when the Loki ruler is
 * not enabled. Runs on the leader every ALERTING_EVALUATE_INTERVAL_MS with instant queries.
 *
 * SLO status (error ratio, burn rates, error budget remaining) is computed in every mode so
 * the portal's SLO dashboard does not hit Prometheus per page view.
 */
import axios from 'axios';
import { getDb } from '../config/database';
import { AlertMonitor } from '../entities/AlertMonitor';
import { AlertSlo } from '../entities/AlertSlo';
import { Environment } from '../entities/Environment';
import { alertingMode, alertingSettings, alertingUrls, lokiRulerEnabled } from './alerting-config';
import {
  errorBudgetRemaining, evaluateBurnAlerts, evaluateSamples, monitorDedupeKey, monitorExpr, nextMonitorState,
  sloDedupeKey, sloErrorRatioExpr, SLO_WINDOWS, ErrorRatios, burnWindows,
} from './alerting-rules';
import { emitAlertEvent } from './alerting-engine';
import { AlertEvent } from './alert-events';

export type QueryFn = (engine: 'prometheus' | 'loki', expr: string) => Promise<number[]>;

/** Instant-vector values of a Prometheus / Loki query result. */
export function parseQueryResult(body: any): number[] {
  const data = body?.data;
  if (!data) throw new Error('query response has no data');
  if (data.resultType === 'scalar') return [Number(data.result?.[1])];
  if (data.resultType === 'vector') return (data.result || []).map((r: any) => Number(r?.value?.[1]));
  throw new Error(`unsupported result type ${data.resultType} (use an instant/metric query)`);
}

export const httpQuery: QueryFn = async (engine, expr) => {
  const urls = alertingUrls();
  const url = engine === 'loki' ? `${urls.loki}/loki/api/v1/query` : `${urls.prometheus}/api/v1/query`;
  const res = await axios.get(url, { params: { query: expr }, timeout: alertingSettings().queryTimeoutMs, validateStatus: () => true });
  if (res.status !== 200) throw new Error(`${engine} query failed: HTTP ${res.status} ${typeof res.data === 'object' ? res.data?.error || '' : ''}`.trim());
  return parseQueryResult(res.data);
};

export async function projectNamespaces(projectId: string): Promise<string[]> {
  const envs = await (await getDb()).getRepository(Environment).find({ where: { projectId } });
  return envs.map((e) => e.namespace).filter(Boolean);
}

/** Evaluate one monitor, persist its state and emit firing/resolved events on transitions. */
export async function evaluateMonitor(m: AlertMonitor, query: QueryFn = httpQuery, now: Date = new Date(), emit: (e: AlertEvent) => Promise<void> = emitAlertEvent): Promise<string | null> {
  const repo = (await getDb()).getRepository(AlertMonitor);
  let breached = false;
  let value: number | null = null;
  try {
    const { engine, expr } = monitorExpr(m, { namespaces: m.kind === 'resource' ? await projectNamespaces(m.projectId) : [] });
    const r = evaluateSamples(await query(engine, expr), m.operator, Number(m.threshold));
    breached = r.breached;
    value = r.value;
    m.lastError = null;
  } catch (err: any) {
    // Query failures never resolve or fire: keep the previous state.
    m.lastError = String(err?.message || err).slice(0, 500);
    m.lastEvaluatedAt = now;
    await repo.save(m);
    return null;
  }
  const next = nextMonitorState({ state: m.state, pendingSince: m.pendingSince }, breached, now, m.forSeconds);
  m.state = next.state;
  m.pendingSince = next.pendingSince;
  m.lastValue = value;
  m.lastEvaluatedAt = now;
  await repo.save(m);
  if (next.transition) {
    await emit({
      projectId: m.projectId,
      environment: m.params?.environment || undefined,
      source: 'monitor',
      severity: m.severity as AlertEvent['severity'],
      dedupeKey: monitorDedupeKey(m.id),
      title: m.name,
      body: next.transition === 'firing'
        ? `${m.description ? `${m.description}\n` : ''}Value ${value} ${m.operator} ${m.threshold}`
        : `Back to normal (value ${value ?? 'n/a'})`,
      url: `/alerting?projectId=${m.projectId}&tab=monitors`,
      status: next.transition,
      labels: { ...(m.labels || {}), platform_monitor_id: m.id },
      at: now.toISOString(),
    });
  }
  return next.transition;
}

async function ratio(query: QueryFn, expr: string): Promise<number | null> {
  const v = (await query('prometheus', expr)).find((x) => Number.isFinite(x));
  return v === undefined ? null : v;
}

/** Compute SLO status; with `alert` also emit page/ticket burn-rate transitions. */
export async function evaluateSlo(s: AlertSlo, query: QueryFn = httpQuery, now: Date = new Date(), alert = true, emit: (e: AlertEvent) => Promise<void> = emitAlertEvent) {
  const repo = (await getDb()).getRepository(AlertSlo);
  const ratios: ErrorRatios = {};
  let periodRatio: number | null = null;
  let periodAt: string | null = null;
  try {
    for (const w of SLO_WINDOWS) ratios[w] = await ratio(query, sloErrorRatioExpr(s, w));
    // The full-period ratio is a long range query: refresh it at most every 5 minutes.
    const prev = s.status || {};
    const fresh = prev.periodAt && now.getTime() - Date.parse(prev.periodAt) < 5 * 60_000 && typeof prev.errorRatio === 'number';
    periodRatio = fresh ? prev.errorRatio : await ratio(query, sloErrorRatioExpr(s, `${s.windowDays}d`));
    if (!fresh) periodAt = now.toISOString();
    else periodAt = prev.periodAt;
  } catch (err: any) {
    s.status = { ...(s.status || {}), error: String(err?.message || err).slice(0, 500), at: now.toISOString() };
    await repo.save(s);
    return s.status;
  }
  const burn = evaluateBurnAlerts(ratios, s.target, s.windowDays);
  s.status = {
    at: now.toISOString(),
    periodAt,
    errorRatio: periodRatio,
    sli: periodRatio === null ? null : 1 - periodRatio,
    errorBudgetRemaining: periodRatio === null ? null : errorBudgetRemaining(periodRatio, s.target),
    burnRates: burn.burnRates,
    thresholds: burnWindows(s.windowDays),
    alerts: { page: burn.page, ticket: burn.ticket },
  };
  if (alert) {
    const state = { ...(s.alertState || {}) };
    for (const kind of ['page', 'ticket'] as const) {
      const firing = burn[kind];
      const was = state[kind] === 'firing';
      if (firing === was) continue;
      state[kind] = firing ? 'firing' : 'ok';
      await emit({
        projectId: s.projectId,
        source: 'slo',
        severity: kind === 'page' ? 'critical' : 'warning',
        dedupeKey: sloDedupeKey(s.id, kind),
        title: `${s.name}: error budget burn (${kind})`,
        body: firing
          ? `Burn rates: ${Object.entries(burn.burnRates).map(([w, r]) => `${w}=${Number(r).toFixed(2)}`).join(', ')} (objective ${s.target}% over ${s.windowDays}d)`
          : 'Burn rate back under the alert thresholds',
        url: `/alerting?projectId=${s.projectId}&tab=slos`,
        status: firing ? 'firing' : 'resolved',
        labels: { platform_slo_id: s.id, platform_slo_alert: kind },
        at: now.toISOString(),
      });
    }
    s.alertState = state;
  }
  await repo.save(s);
  return s.status;
}

/** One leader run. */
export async function runEvaluation(query: QueryFn = httpQuery, now: Date = new Date()): Promise<{ monitors: number; slos: number }> {
  const mode = alertingMode();
  if (mode === 'off') return { monitors: 0, slos: 0 };
  const ds = await getDb();
  const monitors = (await ds.getRepository(AlertMonitor).find({ where: { enabled: true } }))
    .filter((m) => mode === 'api' || (m.kind === 'log' && !lokiRulerEnabled()));
  for (const m of monitors) await evaluateMonitor(m, query, now);
  const slos = await ds.getRepository(AlertSlo).find({ where: { enabled: true } });
  for (const s of slos) await evaluateSlo(s, query, now, mode === 'api');
  return { monitors: monitors.length, slos: slos.length };
}
