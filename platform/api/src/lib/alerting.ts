import { registerLeaderJob } from './scheduler';
import { stateBackend } from './redis';
import { alertingMode, alertingSettings } from './alerting-config';
import { drainAlertEvents, ALERT_CONSUMER_JOB } from './alerting-consumer';
import { dispatchDeliveries, runEscalations } from './alerting-engine';
import { runEvaluation } from './alerting-evaluator';
import { syncAllRules } from './alerting-k8s';
import { ALERTING_RETENTION_JOB, pruneAlertHistory } from './alerting-retention';

/**
 * Leader jobs of alerting and on-call (#43):
 *
 * | Job                   | Schedule | What                                                    |
 * |-----------------------|----------|---------------------------------------------------------|
 * | alerting-consumer     | 1 s      | ALERT_EVENTS_STREAM -> incidents (Redis only)            |
 * | alerting-dispatch     | 5 s      | send queued notifications, retry with backoff            |
 * | alerting-escalation   | 30 s     | escalation steps, notify after a silence ends            |
 * | alerting-evaluate     | 60 s     | API evaluator (api mode) + SLO status (all modes)        |
 * | alerting-rules-sync   | 5 min    | PrometheusRule / AlertmanagerConfig reconcile (ruler)    |
 * | alerting-retention    | 1 h      | prune old deliveries (30 d) and resolved incidents (180 d) |
 */
let warnAt = 0;
function quiet(name: string, fn: () => Promise<unknown>) {
  return async () => {
    try {
      await fn();
    } catch (err: any) {
      if (Date.now() - warnAt > 30_000) {
        warnAt = Date.now();
        console.warn(`[alerting] ${name} failed: ${err?.message || err}`);
      }
      return 'skipped' as const;
    }
  };
}

export function startAlerting(): void {
  registerLeaderJob({
    name: ALERT_CONSUMER_JOB,
    intervalMs: 1_000,
    initialDelayMs: 2_000,
    run: async () => {
      if (stateBackend() !== 'redis') return 'skipped';
      return quiet('consumer', () => drainAlertEvents())();
    },
  });
  registerLeaderJob({ name: 'alerting-dispatch', intervalMs: 5_000, initialDelayMs: 3_000, run: quiet('dispatch', () => dispatchDeliveries()) });
  registerLeaderJob({ name: 'alerting-escalation', intervalMs: 30_000, initialDelayMs: 10_000, run: quiet('escalation', () => runEscalations()) });
  registerLeaderJob({
    name: 'alerting-evaluate',
    intervalMs: alertingSettings().evaluateIntervalMs,
    initialDelayMs: 20_000,
    run: async () => (alertingMode() === 'off' ? 'skipped' : quiet('evaluate', () => runEvaluation())()),
  });
  registerLeaderJob({
    name: 'alerting-rules-sync',
    intervalMs: 5 * 60_000,
    initialDelayMs: 15_000,
    run: async () => (alertingMode() !== 'ruler' ? 'skipped' : quiet('rules-sync', () => syncAllRules())()),
  });
  registerLeaderJob({
    name: ALERTING_RETENTION_JOB,
    intervalMs: 60 * 60_000,
    initialDelayMs: 5 * 60_000,
    run: quiet('retention', () => pruneAlertHistory()),
  });
}
