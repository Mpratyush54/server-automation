import { IsNull, LessThan, LessThanOrEqual, Not, Repository } from 'typeorm';
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
import { reconcileSyntheticResources } from './synthetic-k8s';

/**
 * Scheduling, result recording and alerting for synthetic checks (#42).
 *
 * The `synthetics-runner` leader job (one replica at a time, runs never overlap) picks
 * due checks every SYNTHETICS_TICK_MS, claims each one by moving next_run_at forward with
 * a conditional UPDATE (so a leader hand-over cannot run a check twice), and runs up to
 * SYNTHETICS_CONCURRENCY at once. Browser checks are not run here: their CronJobs report
 * through the runner API, which calls the same recordResult().
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
  /** Delete results started before `before`; returns screenshot keys of deleted rows. */
  pruneResults(before: Date): Promise<string[]>;
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

  async pruneResults(before: Date): Promise<string[]> {
    const { results } = await this.repos();
    const withShots = await results.find({ where: { startedAt: LessThan(before), screenshotKey: Not(IsNull()) }, select: { id: true, screenshotKey: true }, take: 1000 });
    await results.delete({ startedAt: LessThan(before) });
    return withShots.map((r) => r.screenshotKey!).filter(Boolean);
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
}

/** Run one check now (also used by POST .../run). */
export async function executeCheck(check: SyntheticCheck, deps: TickDeps = {}): Promise<SyntheticResult> {
  const store = deps.store || syntheticStore();
  const startedAt = (deps.now || (() => new Date()))();
  let outcome: RunOutcome;
  try {
    const secrets = decryptCheckSecrets(check.secretsEncrypted);
    const guard = { allowedIngressHosts: await store.ingressHosts(check.projectId) };
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

/** First run of a new/edited check: soon, with jitter so checks do not all fire together. */
export function initialNextRun(intervalSeconds: number, now = Date.now(), rand = Math.random): Date {
  return new Date(now + Math.floor(rand() * Math.min(intervalSeconds, 60)) * 1000 + 5_000);
}

export async function pruneSyntheticResults(store: SyntheticStore = syntheticStore(), now = Date.now()): Promise<number> {
  const before = new Date(now - schedulerSettings().retentionDays * 86_400_000);
  const keys = await store.pruneResults(before);
  for (const key of keys) {
    try { await getUploadStore().delete(key); } catch { /* best effort */ }
  }
  return keys.length;
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
