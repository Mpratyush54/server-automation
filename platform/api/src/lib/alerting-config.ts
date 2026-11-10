/**
 * Alerting settings (#43), all from the environment.
 *
 * Mode:
 *  - `ruler`  (full profile: PLATFORM_OBSERVABILITY=enabled, or ALERTING_MODE=ruler)
 *    Monitors and SLOs are rendered into one PrometheusRule per project; Prometheus evaluates
 *    them and Alertmanager routes them (by the `project` label, one AlertmanagerConfig per
 *    project) back to the API webhook receiver. Log monitors go to the Loki ruler when
 *    ALERTING_LOKI_RULER=enabled, otherwise the API evaluates them.
 *  - `api`    (every other install, or ALERTING_MODE=api)
 *    The leader evaluates monitors and SLO burn rates itself with instant queries.
 *  - `off`    no rule evaluation (events from other features are still routed).
 */
export type AlertingMode = 'ruler' | 'api' | 'off';

function num(name: string, def: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

export function alertingMode(): AlertingMode {
  const explicit = String(process.env.ALERTING_MODE || '').trim().toLowerCase();
  if (explicit === 'ruler' || explicit === 'api' || explicit === 'off') return explicit;
  return String(process.env.PLATFORM_OBSERVABILITY || '').trim().toLowerCase() === 'enabled' ? 'ruler' : 'api';
}

export function lokiRulerEnabled(): boolean {
  return String(process.env.ALERTING_LOKI_RULER || '').trim().toLowerCase() === 'enabled';
}

export const alertingUrls = () => ({
  prometheus: (process.env.ALERTING_PROMETHEUS_URL || process.env.PROMETHEUS_URL || 'http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090').replace(/\/+$/, ''),
  alertmanager: (process.env.ALERTING_ALERTMANAGER_URL || 'http://kube-prometheus-kube-prome-alertmanager.monitoring.svc:9093').replace(/\/+$/, ''),
  loki: (process.env.ALERTING_LOKI_URL || process.env.LOKI_URL || 'http://loki.monitoring.svc:3100').replace(/\/+$/, ''),
  /** Where Alertmanager reaches the API (in-cluster service). */
  apiReceiver: (process.env.ALERTING_RECEIVER_URL || 'http://platform-api.platform.svc.cluster.local:3000/api/alerting/alertmanager/webhook'),
  /** Absolute portal base for links in notifications (https://<DOMAIN>). */
  portal: process.env.DOMAIN ? `https://${process.env.DOMAIN}` : '',
});

export const alertingSettings = () => ({
  /** Namespace of PrometheusRule / AlertmanagerConfig objects and the webhook token Secret. */
  namespace: process.env.ALERTING_NAMESPACE || 'monitoring',
  evaluateIntervalMs: num('ALERTING_EVALUATE_INTERVAL_MS', 60_000, 10_000, 3_600_000),
  queryTimeoutMs: num('ALERTING_QUERY_TIMEOUT_MS', 5_000, 500, 60_000),
  deliveryTimeoutMs: num('ALERTING_DELIVERY_TIMEOUT_MS', 10_000, 1_000, 60_000),
  maxDeliveryAttempts: num('ALERTING_MAX_DELIVERY_ATTEMPTS', 5, 1, 20),
  consumerBatch: num('ALERTING_CONSUMER_BATCH', 100, 1, 1000),
  consumerBudgetMs: num('ALERTING_CONSUMER_BUDGET_MS', 5_000, 100, 60_000),
  consumerReclaimIdleMs: num('ALERTING_CONSUMER_RECLAIM_IDLE_MS', 60_000, 1_000, 3_600_000),
  consumerMaxAttempts: num('ALERTING_CONSUMER_MAX_ATTEMPTS', 5, 1, 50),
});
