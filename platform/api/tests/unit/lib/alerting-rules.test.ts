/**
 * Alerting rule generation (#43): monitor expressions, PrometheusRule / AlertmanagerConfig /
 * Loki rule rendering, Sloth-style SLO rules, burn-rate math, evaluator state machine,
 * legacy alert mapping.
 */
import YAML from 'yaml';
import {
  alertExpr, burnRate, burnWindows, compare, errorBudget, errorBudgetRemaining, evaluateBurnAlerts, evaluateSamples,
  legacyAlertToMonitor, monitorExpr, nextMonitorState, prometheusRuleName, renderAlertmanagerConfig, renderLokiRuleGroup,
  renderPrometheusRule, sanitizeLabels, sloErrorRatioExpr, sloRuleGroup, validateSlo, durationString, MonitorLike, SloLike,
} from '../../../src/lib/alerting-rules';
import { MIGRATE_LEGACY_ALERTS } from '../../../src/migrations/1798000000043-Alerting';

const PID = '11111111-1111-4111-8111-111111111111';
const ctx = { namespaces: ['shop-production-abc', 'shop-staging-def'], ruleNamespace: 'monitoring', portal: 'https://example.test' };

const monitor = (over: Partial<MonitorLike> = {}): MonitorLike => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001', projectId: PID, name: 'High errors', kind: 'metric',
  query: 'sum(rate(http_requests_total{code=~"5.."}[5m]))', params: {}, operator: '>', threshold: 5,
  forSeconds: 300, severity: 'critical', labels: { team: 'web' }, enabled: true, ...over,
});

const slo = (over: Partial<SloLike> = {}): SloLike => ({
  id: 'bbbbbbbb-0000-4000-8000-000000000001', projectId: PID, name: 'Checkout availability', sliType: 'availability',
  params: { service: 'checkout' }, target: 99.9, windowDays: 30, enabled: true, ...over,
});

describe('monitor expressions', () => {
  it('wraps PromQL and appends the condition', () => {
    expect(alertExpr(monitor(), ctx)).toEqual({ engine: 'prometheus', expr: '(sum(rate(http_requests_total{code=~"5.."}[5m]))) > 5' });
  });

  it('log monitors run on Loki', () => {
    expect(monitorExpr(monitor({ kind: 'log', query: 'sum(count_over_time({app="x"} |= "error" [5m]))' }), ctx).engine).toBe('loki');
  });

  it('trace monitors are scoped to the project via span-metrics labels (escaped)', () => {
    const e = monitorExpr(monitor({ kind: 'trace', query: null, params: { signal: 'error_rate', service: 'api"x', environment: 'prod' } }), ctx).expr;
    expect(e).toContain(`platform_project_id="${PID}"`);
    expect(e).toContain('service="api\\"x"');
    expect(e).toContain('deployment_environment="prod"');
    expect(e).toContain('status_code="STATUS_CODE_ERROR"');
    expect(monitorExpr(monitor({ kind: 'trace', params: { signal: 'latency_p95' } }), ctx).expr).toMatch(/^\(1000 \* histogram_quantile\(0\.95/);
  });

  it('resource monitors match only the project namespaces; no namespace matches nothing', () => {
    const e = monitorExpr(monitor({ kind: 'resource', params: { resource: 'cpu' } }), ctx).expr;
    expect(e).toContain('namespace=~"shop-production-abc|shop-staging-def"');
    expect(monitorExpr(monitor({ kind: 'resource', params: { resource: 'memory' } }), { namespaces: [] }).expr).toContain('namespace="__platform_none__"');
  });

  it('rejects invalid monitors', () => {
    expect(() => alertExpr(monitor({ operator: '=~' }), ctx)).toThrow(/operator/);
    expect(() => alertExpr(monitor({ threshold: NaN }), ctx)).toThrow(/threshold/);
    expect(() => monitorExpr(monitor({ query: '' }), ctx)).toThrow(/query is required/);
    expect(() => monitorExpr(monitor({ kind: 'trace', params: {} }), ctx)).toThrow(/signal/);
    expect(() => monitorExpr(monitor({ kind: 'resource', params: { resource: 'disk' } }), ctx)).toThrow(/resource/);
  });

  it('sanitizes user labels (no reserved / platform_ names)', () => {
    expect(sanitizeLabels({ team: 'a', project: 'evil', platform_monitor_id: 'x', 'bad-name': 'y', severity: 'z', ok_2: 3 })).toEqual({ team: 'a', ok_2: '3' });
  });
});

describe('PrometheusRule rendering', () => {
  it('one object per project with project + routing labels on every rule; log monitors and other projects excluded', () => {
    const { object, errors } = renderPrometheusRule(PID, [
      monitor(),
      monitor({ id: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'log', query: 'x' }),
      monitor({ id: 'aaaaaaaa-0000-4000-8000-000000000003', projectId: '22222222-2222-4222-8222-222222222222' }),
      monitor({ id: 'aaaaaaaa-0000-4000-8000-000000000004', enabled: false }),
      monitor({ id: 'aaaaaaaa-0000-4000-8000-000000000005', operator: 'bad' }),
    ], [slo()], ctx);
    expect(object.metadata).toMatchObject({ name: prometheusRuleName(PID), namespace: 'monitoring', labels: { release: 'kube-prometheus', 'platform.io/project': PID } });
    expect(errors).toEqual([{ id: 'aaaaaaaa-0000-4000-8000-000000000005', error: expect.stringMatching(/operator/) }]);
    const [mon, sloGroup] = object.spec.groups;
    expect(mon.rules).toHaveLength(1);
    expect(mon.rules[0]).toMatchObject({
      alert: 'PlatformMonitor_aaaaaaaa0000',
      for: '5m',
      labels: { project: PID, namespace: 'monitoring', severity: 'critical', platform_source: 'monitor', platform_monitor_id: monitor().id, team: 'web' },
      annotations: { summary: 'High errors', platform_url: `https://example.test/alerting?projectId=${PID}&tab=monitors` },
    });
    expect(sloGroup.name).toBe('slo-bbbbbbbb0000');
    for (const g of object.spec.groups) for (const r of g.rules) expect(r.labels.project).toBe(PID);
  });

  it('renders no groups for a project without rules', () => {
    expect(renderPrometheusRule(PID, [], [], ctx).object.spec.groups).toEqual([]);
  });

  it('AlertmanagerConfig routes project=<id> to the API receiver with a secret bearer token', () => {
    const am = renderAlertmanagerConfig(PID, { namespace: 'monitoring', receiverUrl: 'http://api/hook', tokenSecret: 'platform-alerting-webhook' });
    expect(am.spec.route.matchers).toEqual([{ name: 'project', value: PID, matchType: '=' }]);
    expect(am.spec.receivers[0].webhookConfigs[0]).toEqual({
      url: 'http://api/hook', sendResolved: true,
      httpConfig: { authorization: { type: 'Bearer', credentials: { name: 'platform-alerting-webhook', key: 'token' } } },
    });
    expect(JSON.stringify(am)).not.toMatch(/hooks\.slack|pagerduty/);
  });

  it('Loki rule group contains only log monitors, as YAML', () => {
    const g = renderLokiRuleGroup(PID, [monitor(), monitor({ id: 'aaaaaaaa-0000-4000-8000-000000000009', kind: 'log', query: 'sum(rate({app="x"}[5m]))', operator: '>=', threshold: 1 })], ctx);
    expect(g.count).toBe(1);
    const parsed = YAML.parse(g.yaml);
    expect(parsed.name).toBe(`platform-${PID}`);
    expect(parsed.rules[0].expr).toBe('(sum(rate({app="x"}[5m]))) >= 1');
    expect(parsed.rules[0].labels.project).toBe(PID);
  });

  it('durationString', () => {
    expect([0, 30, 300, 3600, 86400, 90].map(durationString)).toEqual(['0s', '30s', '5m', '1h', '1d', '90s']);
  });
});

describe('SLOs', () => {
  it('burn-rate math', () => {
    expect(errorBudget(99.9)).toBeCloseTo(0.001);
    expect(burnRate(0.0144, 99.9)).toBeCloseTo(14.4);
    expect(errorBudgetRemaining(0.0005, 99.9)).toBeCloseTo(0.5);
    expect(errorBudgetRemaining(0.002, 99.9)).toBeCloseTo(-1);
  });

  it('Google SRE factors for 30 days, scaled for other periods', () => {
    expect(burnWindows(30)).toEqual({
      page: [{ long: '1h', short: '5m', factor: 14.4 }, { long: '6h', short: '30m', factor: 6 }],
      ticket: [{ long: '1d', short: '2h', factor: 3 }, { long: '3d', short: '6h', factor: 1 }],
    });
    expect(burnWindows(7).page[0].factor).toBeCloseTo(3.36);
  });

  it('multi-window: both the long and the short window must burn', () => {
    // 2% errors on a 99.9% SLO = burn 20 in 1h and 5m -> page.
    expect(evaluateBurnAlerts({ '5m': 0.02, '1h': 0.02, '30m': 0.02, '6h': 0.004 }, 99.9, 30)).toMatchObject({ page: true, ticket: false });
    // Long window burning but the short window recovered -> no page (alert resets quickly).
    expect(evaluateBurnAlerts({ '5m': 0.0001, '1h': 0.02 }, 99.9, 30).page).toBe(false);
    // Slow burn: 3d and 6h above 1x -> ticket only.
    expect(evaluateBurnAlerts({ '3d': 0.0015, '6h': 0.0015, '1d': 0.0015, '2h': 0.0015 }, 99.9, 30)).toMatchObject({ page: false, ticket: true });
    expect(evaluateBurnAlerts({}, 99.9, 30)).toMatchObject({ page: false, ticket: false });
  });

  it('recording rules for every window + period, objective, budget and page/ticket alerts', () => {
    const g = sloRuleGroup(slo(), ctx);
    const records = g.rules.filter((r: any) => r.record).map((r: any) => r.record);
    expect(records).toEqual([
      'slo:sli_error:ratio_rate5m', 'slo:sli_error:ratio_rate30m', 'slo:sli_error:ratio_rate1h', 'slo:sli_error:ratio_rate2h',
      'slo:sli_error:ratio_rate6h', 'slo:sli_error:ratio_rate1d', 'slo:sli_error:ratio_rate3d', 'slo:sli_error:ratio_rate30d',
      'slo:objective:ratio', 'slo:error_budget:ratio',
    ]);
    const page = g.rules.find((r: any) => r.alert?.endsWith('_page'));
    expect(page.expr).toBe(
      `(slo:sli_error:ratio_rate1h{platform_slo_id="${slo().id}"} > (14.4 * 0.001) and slo:sli_error:ratio_rate5m{platform_slo_id="${slo().id}"} > (14.4 * 0.001))`
      + ` or (slo:sli_error:ratio_rate6h{platform_slo_id="${slo().id}"} > (6 * 0.001) and slo:sli_error:ratio_rate30m{platform_slo_id="${slo().id}"} > (6 * 0.001))`,
    );
    expect(page.labels).toMatchObject({ project: PID, severity: 'critical', platform_source: 'slo', platform_slo_alert: 'page', platform_slo_id: slo().id });
    expect(g.rules.find((r: any) => r.alert?.endsWith('_ticket')).labels.severity).toBe('warning');
    expect(g.rules.find((r: any) => r.record === 'slo:sli_error:ratio_rate30d').expr).toBe(`avg_over_time(slo:sli_error:ratio_rate5m{platform_slo_id="${slo().id}"}[30d])`);
  });

  it('SLI expressions per type', () => {
    expect(sloErrorRatioExpr(slo({ sliType: 'ratio', errorQuery: 'sum(rate(e[$window]))', totalQuery: 'sum(rate(t[$window]))' }), '1h')).toBe('(sum(rate(e[1h]))) / (sum(rate(t[1h])))');
    expect(sloErrorRatioExpr(slo({ sliType: 'latency', params: { latencyMs: 256 } }), '5m')).toContain('le="0.256"');
  });

  it('validates SLOs', () => {
    expect(() => validateSlo(slo({ target: 100 }))).toThrow(/target/);
    expect(() => validateSlo(slo({ windowDays: 0 }))).toThrow(/windowDays/);
    expect(() => validateSlo(slo({ sliType: 'ratio', errorQuery: 'x', totalQuery: 'y[$window]' }))).toThrow(/\$window/);
    expect(() => validateSlo(slo({ sliType: 'latency', params: { latencyMs: 300 } }))).toThrow(/bucket/);
    expect(() => validateSlo(slo({ sliType: 'nope' }))).toThrow(/sliType/);
  });
});

describe('API evaluator state machine', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const at = (s: number) => new Date(t0.getTime() + s * 1000);

  it('compare + samples', () => {
    expect([compare(5, '>', 4), compare(4, '>=', 4), compare(3, '<', 4), compare(4, '<=', 4), compare(4, '==', 4), compare(4, '!=', 4)]).toEqual([true, true, true, true, true, false]);
    expect(evaluateSamples([1, NaN, 9], '>', 5)).toEqual({ breached: true, value: 9 });
    expect(evaluateSamples([], '>', 5)).toEqual({ breached: false, value: null });
  });

  it('ok -> pending -> firing after `for`, then resolves once', () => {
    let s = nextMonitorState({ state: 'ok', pendingSince: null }, true, t0, 120);
    expect(s).toMatchObject({ state: 'pending', transition: null });
    s = nextMonitorState(s, true, at(60), 120);
    expect(s).toMatchObject({ state: 'pending', transition: null });
    s = nextMonitorState(s, true, at(120), 120);
    expect(s).toMatchObject({ state: 'firing', transition: 'firing' });
    s = nextMonitorState(s, true, at(180), 120);
    expect(s.transition).toBeNull();
    s = nextMonitorState(s, false, at(240), 120);
    expect(s).toMatchObject({ state: 'ok', transition: 'resolved' });
    expect(nextMonitorState(s, false, at(300), 120).transition).toBeNull();
  });

  it('pending that recovers never fires or resolves; for=0 fires immediately', () => {
    const p = nextMonitorState({ state: 'ok', pendingSince: null }, true, t0, 300);
    expect(nextMonitorState(p, false, at(10), 300).transition).toBeNull();
    expect(nextMonitorState({ state: 'ok', pendingSince: null }, true, t0, 0).transition).toBe('firing');
  });
});

describe('legacy alerts', () => {
  it('maps legacy metrics to monitors (same as the migration)', () => {
    expect(legacyAlertToMonitor({ id: 'l1', projectId: PID, type: 'cpu_high', severity: 'warning', config: { metric: 'cpu', operator: '>', threshold: 80 }, isEnabled: true }))
      .toMatchObject({ kind: 'resource', params: { resource: 'cpu' }, operator: '>', threshold: 80, enabled: true, legacyAlertId: 'l1' });
    expect(legacyAlertToMonitor({ id: 'l2', projectId: PID, config: { metric: 'errorRate', operator: '==', threshold: '2' } }))
      .toMatchObject({ kind: 'trace', params: { signal: 'error_rate' }, operator: '==', threshold: 2 });
    expect(legacyAlertToMonitor({ id: 'l3', projectId: PID, config: { metric: 'disk' } })).toMatchObject({ enabled: false, params: { resource: 'disk' } });
  });

  it('migration copies rows idempotently and only enables known metrics', () => {
    expect(MIGRATE_LEGACY_ALERTS).toContain('WHERE NOT EXISTS (SELECT 1 FROM "alert_monitors" x WHERE x."legacy_alert_id" = a."id")');
    for (const m of ['cpu', 'memory', 'latency', 'errorRate']) expect(MIGRATE_LEGACY_ALERTS).toContain(`'${m}'`);
  });
});
