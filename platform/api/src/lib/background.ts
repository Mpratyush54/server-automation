import { startStorageHealth } from './storage-providers';
import { repairArgoDefaultBranches } from './argocd-branch-repair';
import { getLeadership } from './leader';
import { registerLeaderJob, unregisterAllJobs } from './scheduler';
import { startPreviewDecayScheduler } from './preview-decay';
import { runDeployRecovery } from './deploy-pipeline';
import { runTokenCleanup, TOKEN_CLEANUP_JOB } from './token-cleanup';
import { startOperationWorker } from './operation-worker';
import { startTelemetryConsumer } from './telemetry-queue';
import { startAlerting } from './alerting';
import { startSyntheticsScheduler } from './synthetic-scheduler';
import { startRedisAclReconcile } from './redis-acl-reconcile';
import { ORIGINS_SYNC_JOB, syncTelemetryOrigins } from './telemetry-origins';
import { startErrorRetention } from './error-retention';
import { startLokiRetentionReconcile } from './loki-retention';

/**
 * Background work inventory (every timer/loop in platform/api/src):
 *
 * | Job             | Where it runs            | Schedule                     |
 * |-----------------|--------------------------|------------------------------|
 * | preview-decay   | leader loop              | PREVIEW_DECAY_INTERVAL_SECONDS (900) |
 * | deploy-recovery | leader loop              | 15 s + on leadership gain    |
 * | token-cleanup   | leader loop              | hourly                       |
 * | deploy rollout  | operation (lib/deploy-op), accepting replica | per POST /deploy |
 * | operation-resume | leader loop             | 60 s + on leadership gain    |
 * | outbox-dispatch | leader loop              | 5 s                          |
 * | operation-cleanup | leader loop            | hourly                       |
 * | telemetry-consumer | leader loop (Redis Streams consumer group) | 1 s (#49) |
 * | alerting-*      | leader loop (see lib/alerting.ts) | 1 s .. 5 min (#43) |
 * | synthetics-runner / -retention / -reconcile | leader loop | 5 s / hourly / 10 min (#42) |
 * | redis-acl-reconcile | leader loop            | 15 s (re-creates project Redis users after a Redis restart) |
 * | telemetry-origins-sync | leader loop (+ debounced on change) | 5 min, 5 s after gain |
 * | error-retention | leader loop              | hourly: error_events past the project's errors retention (#47) |
 * | loki-retention-reconcile | leader loop (full profile) | 10 min: per-project logs retention -> Loki runtime overrides (#47) |
 *
 * Any leader-loop job can instead run as a Kubernetes CronJob
 * (`node dist/jobs/<name>.js`) by listing it in JOBS_EXTERNAL.
 */

export const DEPLOY_RECOVERY_JOB = 'deploy-recovery';

let started = false;

export function startBackgroundWork(): void {
  if (started) return;
  started = true;
  const leadership = getLeadership();

  registerLeaderJob({ name: 'argocd-branch-repair', intervalMs: 60 * 60 * 1000, initialDelayMs: 5000, run: repairArgoDefaultBranches });
  startPreviewDecayScheduler();
  registerLeaderJob({
    name: DEPLOY_RECOVERY_JOB,
    intervalMs: 15_000,
    initialDelayMs: 1_000, // pick up interrupted rollouts right after takeover
    run: runDeployRecovery,
  });
  registerLeaderJob({
    name: TOKEN_CLEANUP_JOB,
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 5 * 60 * 1000,
    run: async () => { await runTokenCleanup(); },
  });
  // Operations (#23): resume interrupted operations, dispatch the outbox, prune rows.
  startOperationWorker();
  // SDK telemetry queue consumer (#49): forwards queued logs/metrics/heartbeats.
  startTelemetryConsumer();
  startAlerting(); // alerting + on-call (#43): events, delivery, escalation, evaluation
  // Synthetic checks (#42): run due checks, prune results, reconcile Probes/CronJobs.
  startSyntheticsScheduler();
  // Retention (#47): error events (Postgres) and per-project logs retention (Loki overrides).
  startErrorRetention();
  startLokiRetentionReconcile();
  startStorageHealth();
  // Project Redis ACL users survive Redis restarts (no aclfile): re-created from stored secrets.
  startRedisAclReconcile();
  // Faro CORS allow-list (monitoring/telemetry-origins); also triggered on change.
  registerLeaderJob({
    name: ORIGINS_SYNC_JOB,
    intervalMs: 5 * 60 * 1000,
    initialDelayMs: 5_000,
    run: async () => ((await syncTelemetryOrigins()) === 'disabled' ? 'skipped' : undefined),
  });

  leadership.start();
  installReleaseOnShutdown();
}

/** Stop timers and give up the Lease (so a peer takes over immediately). */
export async function stopBackgroundWork(): Promise<void> {
  unregisterAllJobs();
  await getLeadership().stop();
  started = false;
}

/**
 * Release the Lease on SIGTERM/SIGINT. If no other shutdown handler is
 * registered, exit afterwards (preserving Node's default behaviour); if one
 * is (e.g. graceful HTTP drain), leave exiting to it.
 */
function installReleaseOnShutdown(): void {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      const timeout = new Promise((r) => setTimeout(r, 3_000).unref());
      void Promise.race([stopBackgroundWork().catch(() => {}), timeout]).then(() => {
        if (process.listenerCount(sig) === 0) process.exit(0);
      });
    });
  }
}
