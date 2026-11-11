import { In, IsNull, LessThan, LessThanOrEqual, Not, Repository } from 'typeorm';
import { getDb } from '../config/database';
import { Environment } from '../entities/Environment';
import { SyntheticAlertPolicy, SyntheticAlertState, SyntheticCheck, SyntheticStatus } from '../entities/SyntheticCheck';
import { SyntheticResult, SyntheticResultStatus } from '../entities/SyntheticResult';
import { AlertEvent, AlertSeverity, publishAlertEvent } from './alert-events';
import { decryptCheckSecrets, normaliseAlertPolicy, projectIngressHosts } from './synthetic-checks';
import { recordRun } from './synthetic-metrics';
import { runCheck, RunDeps, RunOutcome } from './synthetic-runner';
import { registerLeaderJob } from './scheduler';
import { getUploadStore } from './upload-store';
import { browserJobDeadlineSeconds, browserRuntime, lastBrowserJobFailure, platformCaCertificate, reconcileSyntheticResources } from './synthetic-k8s';

/**
 * Scheduling, result recording and alerting for synthetic checks (#42).
 *
 * The `synthetics-runner` leader job (one replica at a time, runs never overlap) picks
 * due checks every SYNTHETICS_TICK_MS, claims each one by moving next_run_at forward with
 * a conditional UPDATE (so a leader hand-over cannot run a check twice), and runs up to
 * SYNTHETICS_CONCURRENCY at once. Browser checks are not run here: their CronJobs report
 * through the runner API, which calls the same recordResult(). A browser check whose
 * runner never reports (image pull failure, OOM, deadline, quota) is caught by the
 * `synthetics-browser-staleness` job: no result for max(2 x interval, interval + job
 * deadline) records a failed result ("runner did not report") that counts towards
 * consecutive failures and alerts like any other failure.
 *
 * Alerting (`synthetics` events, dedupeKey `synthetic:<checkId>`):
 *   fail      → after alertPolicy.failureThreshold consecutive failures: firing (policy severity)
 *   degraded  → (SSL within warnDays) firing with severity warning
 *   pass      → resolved, if anything was firing
 * `synthetics-retention` prunes results (and screenshots) older than SYNTHETICS_RETENTION_DAYS.
 */

export const SYNTHETICS_JOB = 'synthetics-runner';
export const SYNTHETICS_RETENTION_JOB = 'synthetics-retention';
export const SYNTHETICS_RECONCILE_JOB = 'synthetics-reconcile';
export const SYNTHETICS_STALENESS_JOB = 'synthetics-browser-staleness';

export function syntheticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SYNTHETICS || '').toLowerCase() !== 'off';
}

function num(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}

export function schedulerSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    tickMs: num(env.SYNTHETICS_TICK_MS, 5_000, 1_000, 60_000),
    concurrency: num(env.SYNTHETICS_CONCURRENCY, 4, 1, 32),
    retentionDays: num(env.SYNTHETICS_RETENTION_DAYS, 30, 1, 400),
  };
}

// ---------------------------------------------------------------------------
// Alert state machine (pure)
// ---------------------------------------------------------------------------

export interface CheckState {
  consecutiveFailures: number;
  alertState: SyntheticAlertState;
}

export interface Transition {
  consecutiveFailures: number;
  alertState: SyntheticAlertState;
  lastStatus: SyntheticStatus;
  event: { status: 'firing' | 'resolved'; severity: AlertSeverity } | null;
}

export function nextState(state: CheckState, result: SyntheticResultStatus, policyRaw: Partial<SyntheticAlertPolicy> | null | undefined): Transition {
  const policy = normaliseAlertPolicy(policyRaw);
  const failures = result === 'fail' ? (state.consecutiveFailures || 0) + 1 : 0;
  const lastStatus: SyntheticStatus = result === 'pass' ? 'up' : result === 'degraded' ? 'degraded' : 'down';
  const current = state.alertState || 'ok';
  if (!policy.enabled) {
    return { consecutiveFailures: failures, alertState: 'ok', lastStatus, event: current !== 'ok' ? { status: 'resolved', severity: 'info' } : null };
  }
  if (result === 'pass') {
    return { consecutiveFailures: 0, alertState: 'ok', lastStatus, event: current !== 'ok' ? { status: 'resolved', severity: 'info' } : null };
  }
  if (result === 'degraded') {
    return { consecutiveFailures: 0, alertState: 'warning', lastStatus, event: current !== 'warning' ? { status: 'firing', severity: 'warning' } : null };
  }
  if (failures >= policy.failureThreshold && current !== 'firing') {
    return { consecutiveFailures: failures, alertState: 'firing', lastStatus, event: { status: 'firing', severity: policy.severity } };
  }
  return { consecutiveFailures: failures, alertState: current, lastStatus, event: null };
}

export function buildAlertEvent(
  check: Pick<SyntheticCheck, 'id' | 'projectId' | 'name' | 'type' | 'environmentId'>,
  t: NonNullable<Transition['event']>,
  detail: { error: string | null; consecutiveFailures: number; result: SyntheticResultStatus },
): AlertEvent {
  let title: string;
  if (t.status === 'resolved') title = `Synthetic check "${check.name}" recovered`;
  else if (detail.result === 'degraded') title = `Synthetic check "${check.name}": certificate expires soon`;
  else title = `Synthetic check "${check.name}" is failing (${detail.consecutiveFailures} consecutive failures)`;
  return {
    projectId: check.projectId,
    source: 'synthetics',
    severity: t.severity,
    dedupeKey: `synthetic:${check.id}`,
    status: t.status,
    title,
    ...(detail.error && t.status === 'firing' ? { body: detail.error } : {}),
    url: `/projects/${check.projectId}/synthetics?check=${check.id}`,
    labels: { checkId: check.id, checkType: check.type, ...(check.environmentId ? { environmentId: check.environmentId } : {}) },
  };
}

// ---------------------------------------------------------------------------
// Store (TypeORM; tests inject an in-memory one)
// ---------------------------------------------------------------------------

export interface SyntheticStore {
  listDue(now: Date, limit: number): Promise<SyntheticCheck[]>;
  /** Move next_run_at from `expected` to `next`; false when another run claimed it. */
  claim(id: string, expected: Date | null, next: Date): Promise<boolean>;
  updateCheck(id: string, patch: Partial<SyntheticCheck>): Promise<void>;
  saveResult(result: Partial<SyntheticResult>): Promise<SyntheticResult>;
  ingressHosts(projectId: string): Promise<string[]>;
  /** Delete results started before `before` that have no screenshot; returns how many. */
  pruneResultsWithoutScreenshot(before: Date): Promise<number>;
  /** Oldest results started before `before` that still reference a screenshot. */
  listExpiredScreenshots(before: Date, limit: number): Promise<Array<{ id: string; screenshotKey: string }>>;
  /** Delete these result rows (their screenshots are already gone). */
  deleteResults(ids: string[]): Promise<void>;
  /** Enabled browser checks (staleness detection). */
  listEnabledBrowserChecks(limit: number): Promise<SyntheticCheck[]>;
}

export class TypeormSyntheticStore implements SyntheticStore {
  private async repos(): Promise<{ checks: Repository<SyntheticCheck>; results: Repository<SyntheticResult>; envs: Repository<Environment> }> {
    const ds = await getDb();
    return { checks: ds.getRepository(SyntheticCheck), results: ds.getRepository(SyntheticResult), envs: ds.getRepository(Environment) };
  }

  async listDue(now: Date, limit: number): Promise<SyntheticCheck[]> {
    const { checks } = await this.repos();
    const base = { enabled: true, type: Not('browser' as const) } as any;
    return checks.find({
      where: [{ ...base, nextRunAt: LessThanOrEqual(now) }, { ...base, nextRunAt: IsNull() }],
      order: { nextRunAt: 'ASC' },
      take: limit,
    });
  }

  async claim(id: string, expected: Date | null, next: Date): Promise<boolean> {
    const { checks } = await this.repos();
    const res = await checks.update({ id, nextRunAt: expected === null ? IsNull() : expected } as any, { nextRunAt: next });
    return (res.affected ?? 0) === 1;
  }

  async updateCheck(id: string, patch: Partial<SyntheticCheck>): Promise<void> {
    const { checks } = await this.repos();
    await checks.update({ id }, patch as any);
  }

  async saveResult(result: Partial<SyntheticResult>): Promise<SyntheticResult> {
    const { results } = await this.repos();
    return results.save(results.create(result));
  }

  async ingressHosts(projectId: string): Promise<string[]> {
    const { envs } = await this.repos();
    return projectIngressHosts(await envs.find({ where: { projectId } }));
  }

  async pruneResultsWithoutScreenshot(before: Date): Promise<number> {
    const { results } = await this.repos();
    const res = await results.delete({ startedAt: LessThan(before), screenshotKey: IsNull() });
    return res.affected ?? 0;
  }

  async listExpiredScreenshots(before: Date, limit: number): Promise<Array<{ id: string; screenshotKey: string }>> {
    const { results } = await this.repos();
    const rows = await results.find({
      where: { startedAt: LessThan(before), screenshotKey: Not(IsNull()) },
      select: { id: true, screenshotKey: true },
      order: { startedAt: 'ASC' },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, screenshotKey: r.screenshotKey! }));
  }

  async listEnabledBrowserChecks(limit: number): Promise<SyntheticCheck[]> {
    const { checks } = await this.repos();
    return checks.find({ where: { enabled: true, type: 'browser' } as any, take: limit });
  }

  async deleteResults(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { results } = await this.repos();
    await results.delete({ id: In(ids) });
  }
}

let defaultStore: SyntheticStore | null = null;
export function syntheticStore(): SyntheticStore {
  if (!defaultStore) defaultStore = new TypeormSyntheticStore();
  return defaultStore;
}
export function setSyntheticStoreForTests(s: SyntheticStore | null): void {
  defaultStore = s;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordOptions {
  startedAt: Date;
  screenshotKey?: string | null;
  publish?: (e: AlertEvent) => Promise<void>;
}

/** Store one run, update the check's state, and publish alert transitions. */
export async function recordResult(store: SyntheticStore, check: SyntheticCheck, outcome: RunOutcome, opts: RecordOptions): Promise<SyntheticResult> {
  const saved = await store.saveResult({
    checkId: check.id,
    projectId: check.projectId,
    status: outcome.status,
    latencyMs: outcome.latencyMs === null ? null : Math.round(outcome.latencyMs),
    statusCode: outcome.statusCode,
    error: outcome.error,
    assertions: outcome.assertions,
    steps: outcome.steps,
    sslExpiresAt: outcome.sslExpiresAt,
    screenshotKey: opts.screenshotKey || null,
    location: 'local',
    startedAt: opts.startedAt,
  });
  const t = nextState(check, outcome.status, check.alertPolicy);
  await store.updateCheck(check.id, {
    lastRunAt: opts.startedAt,
    lastStatus: t.lastStatus,
    lastLatencyMs: saved.latencyMs,
    lastError: outcome.error,
    consecutiveFailures: t.consecutiveFailures,
    alertState: t.alertState,
    ...(outcome.sslExpiresAt ? { sslExpiresAt: outcome.sslExpiresAt } : {}),
  });
  recordRun(check.type, outcome.status);
  if (t.event) {
    await (opts.publish || publishAlertEvent)(buildAlertEvent(check, t.event, { error: outcome.error, consecutiveFailures: t.consecutiveFailures, result: outcome.status }));
  }
  Object.assign(check, { consecutiveFailures: t.consecutiveFailures, alertState: t.alertState, lastStatus: t.lastStatus });
  return saved;
}

/** Resolve an open alert (check deleted or disabled). */
export async function resolveCheckAlert(check: SyntheticCheck, publish: (e: AlertEvent) => Promise<void> = publishAlertEvent): Promise<void> {
  if (!check.alertState || check.alertState === 'ok') return;
  await publish(buildAlertEvent(check, { status: 'resolved', severity: 'info' }, { error: null, consecutiveFailures: 0, result: 'pass' }));
}

export interface TickDeps {
  store?: SyntheticStore;
  now?: () => Date;
  run?: (check: SyntheticCheck, deps: RunDeps) => Promise<RunOutcome>;
  publish?: (e: AlertEvent) => Promise<void>;
  concurrency?: number;
  /** Platform CA lookup (default: the synthetics/platform-ca ConfigMap). */
  platformCa?: () => Promise<string | null>;
}

/** Run one check now (also used by POST .../run). */
export async function executeCheck(check: SyntheticCheck, deps: TickDeps = {}): Promise<SyntheticResult> {
  const store = deps.store || syntheticStore();
  const startedAt = (deps.now || (() => new Date()))();
  let outcome: RunOutcome;
  try {
    const secrets = decryptCheckSecrets(check.secretsEncrypted);
    // Platform hosts (DOMAIN / *.DOMAIN) go to the ingress controller; their certificate
    // may come from the platform CA (#152).
    const guard = {
      allowedIngressHosts: await store.ingressHosts(check.projectId),
      platformCa: check.type === 'browser' ? null : await (deps.platformCa || platformCaCertificate)(),
    };
    outcome = await (deps.run || runCheck)(check, { guard, secrets });
  } catch (err: any) {
    outcome = { status: 'fail', latencyMs: null, statusCode: null, error: `Runner error: ${String(err?.message || err).slice(0, 300)}`, assertions: null, steps: null, sslExpiresAt: null, sslDaysRemaining: null };
  }
  return recordResult(store, check, outcome, { startedAt, publish: deps.publish });
}

/** One scheduler tick: claim and run due checks. Returns how many ran. */
export async function runDueChecks(deps: TickDeps = {}): Promise<number> {
  const store = deps.store || syntheticStore();
  const now = (deps.now || (() => new Date()))();
  const concurrency = deps.concurrency || schedulerSettings().concurrency;
  const due = await store.listDue(now, concurrency);
  const claimed: SyntheticCheck[] = [];
  for (const check of due) {
    const next = new Date(now.getTime() + check.intervalSeconds * 1000);
    if (await store.claim(check.id, check.nextRunAt, next)) {
      check.nextRunAt = next;
      claimed.push(check);
    }
  }
  await Promise.all(claimed.map((c) => executeCheck(c, { ...deps, store }).catch((err) => {
    console.warn(`[synthetics] check ${c.id} failed to record: ${err?.message || err}`);
  })));
  return claimed.length;
}

// ---------------------------------------------------------------------------
// Browser checks that stop reporting
// ---------------------------------------------------------------------------

/** How long a browser check may go without a result: max(2 x interval, interval + job deadline). */
export function browserStaleAfterMs(check: Pick<SyntheticCheck, 'intervalSeconds' | 'timeoutMs'>): number {
  const interval = check.intervalSeconds * 1000;
  return Math.max(2 * interval, interval + browserJobDeadlineSeconds(check.timeoutMs) * 1000);
}

/**
 * Whether an enabled browser check is overdue. Measured from its last result, or from its
 * last change (creation, edit, re-enable) when that is more recent, so a new or re-enabled
 * check gets a full window before it is declared stale.
 */
export function browserCheckStale(
  check: Pick<SyntheticCheck, 'type' | 'enabled' | 'intervalSeconds' | 'timeoutMs' | 'lastRunAt' | 'updatedAt' | 'createdAt'>,
  now: number,
): boolean {
  if (check.type !== 'browser' || !check.enabled) return false;
  const t = (d: Date | null | undefined) => (d ? new Date(d).getTime() : 0);
  const since = Math.max(t(check.lastRunAt), t(check.updatedAt), t(check.createdAt));
  return since > 0 && now - since > browserStaleAfterMs(check);
}

export interface StalenessDeps {
  store?: SyntheticStore;
  now?: () => Date;
  publish?: (e: AlertEvent) => Promise<void>;
  /** Why the latest runner Job failed (Kubernetes, best effort). */
  jobFailure?: (checkId: string) => Promise<string | null>;
  /** Whether browser checks are enabled on this cluster. */
  runtimeEnabled?: () => Promise<boolean>;
}

/** Record a failed result for every overdue browser check. Returns how many were recorded. */
export async function detectStaleBrowserChecks(deps: StalenessDeps = {}): Promise<number> {
  const store = deps.store || syntheticStore();
  const now = (deps.now || (() => new Date()))();
  const stale = (await store.listEnabledBrowserChecks(5000)).filter((c) => browserCheckStale(c, now.getTime()));
  if (stale.length === 0) return 0;
  const enabled = await (deps.runtimeEnabled || (async () => (await browserRuntime()).enabled))().catch(() => true);
  let recorded = 0;
  for (const check of stale) {
    let detail: string | null = enabled ? null : 'browser checks are not enabled on this cluster';
    if (!detail) detail = await (deps.jobFailure || lastBrowserJobFailure)(check.id).catch(() => null);
    const minutes = Math.round(browserStaleAfterMs(check) / 60_000);
    const error = `Runner did not report a result within ${minutes} minutes${detail ? ` (${detail})` : ''}`.slice(0, 500);
    try {
      await recordResult(store, check, {
        status: 'fail', latencyMs: null, statusCode: null, error, assertions: null, steps: null, sslExpiresAt: null, sslDaysRemaining: null,
      }, { startedAt: now, publish: deps.publish });
      recorded++;
    } catch (err: any) {
      console.warn(`[synthetics] recording a missing report for ${check.id} failed: ${err?.message || err}`);
    }
  }
  return recorded;
}

/** First run of a new/edited check: soon, with jitter so checks do not all fire together. */
export function initialNextRun(intervalSeconds: number, now = Date.now(), rand = Math.random): Date {
  return new Date(now + Math.floor(rand() * Math.min(intervalSeconds, 60)) * 1000 + 5_000);
}

export interface PruneOptions {
  batchSize?: number;
  /** Stop starting new batches after this long; the next run continues. */
  budgetMs?: number;
  deleteObject?: (key: string) => Promise<void>;
  clock?: () => number;
}

/**
 * Retention: rows without a screenshot are deleted in one statement; rows with one are
 * deleted in batches, and only once their screenshot object is deleted, so no object is
 * ever left without a row pointing at it. A row whose object cannot be deleted stays for
 * the next run; a batch where nothing could be deleted (store down) ends the run.
 */
export async function pruneSyntheticResults(store: SyntheticStore = syntheticStore(), now = Date.now(), opts: PruneOptions = {}): Promise<number> {
  const before = new Date(now - schedulerSettings().retentionDays * 86_400_000);
  const batchSize = opts.batchSize ?? 500;
  const budgetMs = opts.budgetMs ?? 5 * 60_000;
  const clock = opts.clock || Date.now;
  const deleteObject = opts.deleteObject || ((key: string) => getUploadStore().delete(key));
  let removed = await store.pruneResultsWithoutScreenshot(before);
  const started = clock();
  while (clock() - started < budgetMs) {
    const batch = await store.listExpiredScreenshots(before, batchSize);
    if (batch.length === 0) break;
    const done: string[] = [];
    for (const row of batch) {
      try {
        await deleteObject(row.screenshotKey);
        done.push(row.id);
      } catch {
        /* keep the row: retried next run */
      }
    }
    await store.deleteResults(done);
    removed += done.length;
    if (done.length === 0 || batch.length < batchSize) break;
  }
  return removed;
}

let lastWarn = 0;

export function startSyntheticsScheduler(): void {
  if (!syntheticsEnabled()) return;
  const s = schedulerSettings();
  registerLeaderJob({
    name: SYNTHETICS_JOB,
    intervalMs: s.tickMs,
    initialDelayMs: 10_000,
    run: async () => {
      try {
        await runDueChecks();
      } catch (err: any) {
        if (Date.now() - lastWarn > 60_000) {
          lastWarn = Date.now();
          console.warn(`[synthetics] scheduler tick failed: ${err?.message || err}`);
        }
        return 'skipped';
      }
    },
  });
  registerLeaderJob({
    name: SYNTHETICS_RETENTION_JOB,
    intervalMs: 60 * 60 * 1000,
    initialDelayMs: 10 * 60 * 1000,
    run: async () => { await pruneSyntheticResults(); },
  });
  registerLeaderJob({
    name: SYNTHETICS_STALENESS_JOB,
    intervalMs: 60 * 1000,
    initialDelayMs: 2 * 60 * 1000,
    run: async () => { await detectStaleBrowserChecks(); },
  });
  // Probes / browser CronJobs drift (failed applies, deleted checks, image changes).
  registerLeaderJob({
    name: SYNTHETICS_RECONCILE_JOB,
    intervalMs: 10 * 60 * 1000,
    initialDelayMs: 60 * 1000,
    run: async () => {
      const ds = await getDb();
      await reconcileSyntheticResources(await ds.getRepository(SyntheticCheck).find({ take: 5000 }));
    },
  });
}
