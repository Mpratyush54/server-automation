/**
 * Incident lifecycle, silences, routing and escalation (#43).
 *
 * Every alert, whatever produced it (API evaluator, Alertmanager webhook, error tracking,
 * synthetics, deploys, ...), arrives here as an {@link AlertEvent}:
 *
 *   firing   no open incident for (project, dedupeKey) -> open one; unless a silence matches,
 *            queue step 0 of the escalation policy (deliveries). Open incident -> count it,
 *            never notify again (dedupe).
 *   resolved open incident -> resolved; every channel/user that was notified gets one
 *            resolution message. Unknown key -> ignored.
 *
 * Deliveries are rows (alert_deliveries) sent by the leader's dispatcher with retry and
 * backoff, so a slow or failing Slack never blocks event processing. Escalation: while an
 * incident is firing and not acknowledged, step N+1 is queued delayMinutes after it opened.
 */
import { getDb } from '../config/database';
import { AlertEvent, AlertSeverity, publishAlertEvent } from './alert-events';
import { stateBackend } from './redis';
import { AlertIncident } from '../entities/AlertIncident';
import { AlertDelivery } from '../entities/AlertDelivery';
import { AlertChannel } from '../entities/AlertChannel';
import { AlertSilence, SilenceMatcher } from '../entities/AlertSilence';
import { AlertEscalationPolicy, EscalationStep } from '../entities/AlertEscalationPolicy';
import { AlertOncallSchedule } from '../entities/AlertOncallSchedule';
import { AlertMonitor } from '../entities/AlertMonitor';
import { AlertSlo } from '../entities/AlertSlo';
import { Project } from '../entities/Project';
import { SmtpConfig } from '../entities/SmtpConfig';
import { SEVERITIES, SEVERITY_RANK } from './alerting-rules';
import { AlertMessage, axiosHttpPost, ChannelDeps, DeliveryError, sendToChannel, severityAllowed } from './alerting-channels';
import { alertingSettings, alertingUrls } from './alerting-config';
import { notifyUser } from './notify';

const SOURCES = ['error-tracking', 'synthetics', 'deploy', 'database', 'slo', 'monitor', 'status-page'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMELINE_MAX = 50;

export class InvalidAlertEventError extends Error {}

/** Validate + normalise an event from any producer. Throws InvalidAlertEventError. */
export function normalizeEvent(raw: any): Required<Pick<AlertEvent, 'projectId' | 'source' | 'severity' | 'dedupeKey' | 'title' | 'status' | 'at'>> & AlertEvent {
  if (!raw || typeof raw !== 'object') throw new InvalidAlertEventError('event must be an object');
  if (!UUID.test(String(raw.projectId || ''))) throw new InvalidAlertEventError('projectId must be a uuid');
  if (!SOURCES.includes(raw.source)) throw new InvalidAlertEventError('unknown source');
  const dedupeKey = String(raw.dedupeKey || '').trim();
  if (!dedupeKey || dedupeKey.length > 300) throw new InvalidAlertEventError('dedupeKey is required (max 300 characters)');
  const status = raw.status === 'resolved' ? 'resolved' : 'firing';
  const severity: AlertSeverity = (SEVERITIES as readonly string[]).includes(raw.severity) ? raw.severity : 'warning';
  const title = String(raw.title || dedupeKey).slice(0, 300);
  const labels: Record<string, string> = {};
  if (raw.labels && typeof raw.labels === 'object') {
    for (const [k, v] of Object.entries(raw.labels).slice(0, 50)) labels[String(k).slice(0, 100)] = String(v).slice(0, 500);
  }
  const at = raw.at && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : new Date().toISOString();
  const url = typeof raw.url === 'string' && raw.url.startsWith('/') && !raw.url.startsWith('//') ? raw.url.slice(0, 500) : undefined;
  return {
    projectId: String(raw.projectId),
    environment: raw.environment ? String(raw.environment).slice(0, 50) : undefined,
    source: raw.source,
    severity,
    dedupeKey,
    title,
    body: raw.body ? String(raw.body).slice(0, 4000) : undefined,
    url,
    status,
    labels,
    at,
  };
}

// ---------------------------------------------------------------------------
// Silences
// ---------------------------------------------------------------------------

export function eventLabelSet(e: Pick<AlertEvent, 'source' | 'severity' | 'dedupeKey' | 'environment' | 'labels' | 'title'>): Record<string, string> {
  return {
    ...(e.labels || {}),
    source: e.source,
    severity: e.severity,
    dedupeKey: e.dedupeKey,
    alertname: e.title || '',
    ...(e.environment ? { environment: e.environment } : {}),
  };
}

export function validateMatchers(raw: unknown): SilenceMatcher[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error('matchers must be an array (max 20)');
  return raw.map((m: any) => {
    const name = String(m?.name || '').trim();
    const value = String(m?.value ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error(`invalid matcher name ${name}`);
    if (value.length > 200) throw new Error('matcher value too long');
    const isRegex = !!m?.isRegex;
    if (isRegex) {
      try { new RegExp(`^(?:${value})$`); } catch { throw new Error(`invalid regex for ${name}`); }
    }
    return { name, value, isRegex, isEqual: m?.isEqual !== false };
  });
}

export function matcherMatches(m: SilenceMatcher, labels: Record<string, string>): boolean {
  const v = labels[m.name] ?? '';
  const hit = m.isRegex ? new RegExp(`^(?:${m.value})$`).test(v) : v === m.value;
  return m.isEqual === false ? !hit : hit;
}

export function silenceActive(s: Pick<AlertSilence, 'startsAt' | 'endsAt'>, now: Date): boolean {
  return new Date(s.startsAt).getTime() <= now.getTime() && now.getTime() < new Date(s.endsAt).getTime();
}

/** Alertmanager semantics: active and every matcher matches (no matchers = whole project). */
export function silenceMatches(s: AlertSilence, labels: Record<string, string>, now: Date): boolean {
  return silenceActive(s, now) && (s.matchers || []).every((m) => matcherMatches(m, labels));
}

async function findSilence(projectId: string, labels: Record<string, string>, now: Date): Promise<AlertSilence | null> {
  const ds = await getDb();
  const silences = await ds.getRepository(AlertSilence).find({ where: { projectId } });
  return silences.find((s) => silenceMatches(s, labels, now)) || null;
}

// ---------------------------------------------------------------------------
// On-call + routing
// ---------------------------------------------------------------------------

/** Who is on call now: an active override, else the rotation slot; null when nobody is. */
export function currentOncall(s: Pick<AlertOncallSchedule, 'userIds' | 'rotationHours' | 'startsAt' | 'overrides'>, now: Date): string | null {
  for (const o of s.overrides || []) {
    if (Date.parse(o.startsAt) <= now.getTime() && now.getTime() < Date.parse(o.endsAt)) return o.userId;
  }
  const users = s.userIds || [];
  if (!users.length) return null;
  const slotMs = Math.max(1, s.rotationHours || 168) * 3600_000;
  const elapsed = now.getTime() - new Date(s.startsAt).getTime();
  const idx = elapsed <= 0 ? 0 : Math.floor(elapsed / slotMs) % users.length;
  return users[idx];
}

export function validateSteps(raw: unknown): EscalationStep[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10) throw new Error('steps must be an array of 1..10 steps');
  let prev = -1;
  return raw.map((s: any, i: number) => {
    const delay = i === 0 ? 0 : Number(s?.delayMinutes);
    if (!Number.isFinite(delay) || delay < 0 || delay > 7 * 24 * 60) throw new Error(`steps[${i}].delayMinutes must be 0..10080`);
    if (delay < prev) throw new Error('step delays must not decrease (they count from when the incident opened)');
    prev = delay;
    const ids = (v: any, field: string) => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.length > 20 || !v.every((x) => UUID.test(String(x)))) throw new Error(`steps[${i}].${field} must be a list of ids`);
      return v.map(String);
    };
    const step = { delayMinutes: delay, channelIds: ids(s?.channelIds, 'channelIds'), scheduleIds: ids(s?.scheduleIds, 'scheduleIds'), userIds: ids(s?.userIds, 'userIds') };
    if (!step.channelIds.length && !step.scheduleIds.length && !step.userIds.length) throw new Error(`steps[${i}] needs at least one channel, schedule or user`);
    return step;
  });
}

async function policyIdForEvent(e: AlertEvent): Promise<string | null> {
  const ds = await getDb();
  const monitorId = e.labels?.platform_monitor_id;
  const sloId = e.labels?.platform_slo_id;
  if (monitorId && UUID.test(monitorId)) {
    const m = await ds.getRepository(AlertMonitor).findOne({ where: { id: monitorId } });
    if (m && m.projectId === e.projectId) return m.policyId;
  }
  if (sloId && UUID.test(sloId)) {
    const s = await ds.getRepository(AlertSlo).findOne({ where: { id: sloId } });
    if (s && s.projectId === e.projectId) return s.policyId;
  }
  return null;
}

async function loadPolicy(projectId: string, policyId: string | null): Promise<AlertEscalationPolicy | null> {
  const repo = (await getDb()).getRepository(AlertEscalationPolicy);
  if (policyId) {
    const p = await repo.findOne({ where: { id: policyId } });
    if (p && p.projectId === projectId) return p;
  }
  return repo.findOne({ where: { projectId, isDefault: true } });
}

interface Target { channelId?: string; userId?: string }

/** Targets of one step. Without a policy: every enabled channel of the project (step 0 only). */
async function stepTargets(projectId: string, policy: AlertEscalationPolicy | null, step: number, now: Date): Promise<Target[]> {
  const ds = await getDb();
  if (!policy) {
    if (step > 0) return [];
    const channels = await ds.getRepository(AlertChannel).find({ where: { projectId, enabled: true } });
    return channels.map((c) => ({ channelId: c.id }));
  }
  const s = policy.steps?.[step];
  if (!s) return [];
  const out: Target[] = (s.channelIds || []).map((channelId) => ({ channelId }));
  const users = new Set(s.userIds || []);
  for (const id of s.scheduleIds || []) {
    const sched = await ds.getRepository(AlertOncallSchedule).findOne({ where: { id } });
    if (!sched || sched.projectId !== projectId) continue;
    const u = currentOncall(sched, now);
    if (u) users.add(u);
  }
  for (const userId of users) out.push({ userId });
  return out;
}

async function enqueue(incident: AlertIncident, targets: Target[], event: string, now: Date): Promise<number> {
  if (!targets.length) return 0;
  const repo = (await getDb()).getRepository(AlertDelivery);
  const seen = new Set<string>();
  const rows = targets
    .filter((t) => {
      const k = t.channelId ? `c:${t.channelId}` : `u:${t.userId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((t) => repo.create({
      incidentId: incident.id,
      projectId: incident.projectId,
      channelId: t.channelId || null,
      userId: t.userId || null,
      event,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      sentAt: null,
    }));
  await repo.save(rows);
  return rows.length;
}

function nextEscalationAt(incident: AlertIncident, policy: AlertEscalationPolicy | null, afterStep: number): Date | null {
  const next = policy?.steps?.[afterStep + 1];
  if (!next) return null;
  return new Date(new Date(incident.firstSeenAt).getTime() + next.delayMinutes * 60_000);
}

function addTimeline(incident: AlertIncident, now: Date, type: string, detail?: string): void {
  const t = [...(incident.timeline || []), { at: now.toISOString(), type, ...(detail ? { detail } : {}) }];
  incident.timeline = t.slice(-TIMELINE_MAX);
}

/** Queue step 0 (or the current step after a silence ended) and schedule the next escalation. */
async function notifyOpen(incident: AlertIncident, now: Date): Promise<void> {
  const policy = await loadPolicy(incident.projectId, incident.policyId);
  const targets = await stepTargets(incident.projectId, policy, incident.escalationStep, now);
  const n = await enqueue(incident, targets, incident.escalationStep === 0 ? 'firing' : 'escalation', now);
  incident.notifiedAt = now;
  incident.nextEscalationAt = nextEscalationAt(incident, policy, incident.escalationStep);
  addTimeline(incident, now, 'notified', `step ${incident.escalationStep}: ${n} target(s)`);
}

async function findOpen(projectId: string, dedupeKey: string): Promise<AlertIncident | null> {
  const repo = (await getDb()).getRepository(AlertIncident);
  return (await repo.findOne({ where: { projectId, dedupeKey, status: 'firing' } }))
    || repo.findOne({ where: { projectId, dedupeKey, status: 'acknowledged' } });
}

/** Everyone who was sent (or is about to be sent) an open/escalation message. */
async function notifiedTargets(incidentId: string): Promise<Target[]> {
  const rows = await (await getDb()).getRepository(AlertDelivery).find({ where: { incidentId } });
  return rows
    .filter((d) => (d.event === 'firing' || d.event === 'escalation') && d.status !== 'skipped')
    .map((d) => (d.channelId ? { channelId: d.channelId } : { userId: d.userId! }));
}

export type ProcessResult = { action: 'opened' | 'silenced' | 'deduplicated' | 'resolved' | 'ignored'; incidentId?: string };

/** Apply one event. Idempotent for repeats of the same state. */
export async function processAlertEvent(raw: AlertEvent, now: Date = new Date()): Promise<ProcessResult> {
  const e = normalizeEvent(raw);
  const ds = await getDb();
  const repo = ds.getRepository(AlertIncident);
  const open = await findOpen(e.projectId, e.dedupeKey);

  if (e.status === 'resolved') {
    if (!open) return { action: 'ignored' };
    open.status = 'resolved';
    open.resolvedAt = now;
    open.nextEscalationAt = null;
    open.lastSeenAt = now;
    addTimeline(open, now, 'resolved', 'resolved by source');
    await repo.save(open);
    if (open.notifiedAt) await enqueue(open, await notifiedTargets(open.id), 'resolved', now);
    return { action: 'resolved', incidentId: open.id };
  }

  if (open) {
    open.eventCount = (open.eventCount || 0) + 1;
    open.lastSeenAt = now;
    if ((SEVERITY_RANK[e.severity] || 0) > (SEVERITY_RANK[open.severity] || 0)) {
      addTimeline(open, now, 'severity', `${open.severity} -> ${e.severity}`);
      open.severity = e.severity;
    }
    if (e.body) open.body = e.body;
    await repo.save(open);
    return { action: 'deduplicated', incidentId: open.id };
  }

  const incident = repo.create({
    projectId: e.projectId,
    dedupeKey: e.dedupeKey,
    source: e.source,
    severity: e.severity,
    status: 'firing',
    title: e.title,
    body: e.body || null,
    url: e.url || null,
    environment: e.environment || null,
    labels: e.labels || {},
    policyId: await policyIdForEvent(e),
    silencedBy: null,
    escalationStep: 0,
    nextEscalationAt: null,
    notifiedAt: null,
    eventCount: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    timeline: [],
  });
  addTimeline(incident, now, 'opened', `${e.source} ${e.severity}`);
  const silence = await findSilence(e.projectId, eventLabelSet(e), now);
  if (silence) {
    incident.silencedBy = silence.id;
    addTimeline(incident, now, 'silenced', silence.comment || silence.id);
  }
  try {
    await repo.save(incident);
  } catch (err: any) {
    // Lost a race on the open-incident unique index: treat as a repeat.
    if (String(err?.code) === '23505') {
      const again = await findOpen(e.projectId, e.dedupeKey);
      if (again) {
        again.eventCount += 1;
        again.lastSeenAt = now;
        await repo.save(again);
        return { action: 'deduplicated', incidentId: again.id };
      }
    }
    throw err;
  }
  if (silence) return { action: 'silenced', incidentId: incident.id };
  await notifyOpen(incident, now);
  await repo.save(incident);
  return { action: 'opened', incidentId: incident.id };
}

/** Alert events produced by the API itself: through the stream with Redis, inline without. */
export async function emitAlertEvent(e: AlertEvent): Promise<void> {
  if (stateBackend() === 'redis') {
    await publishAlertEvent(e);
    return;
  }
  try {
    await processAlertEvent(e);
  } catch (err: any) {
    console.warn(`[alerting] inline event processing failed: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Manual actions
// ---------------------------------------------------------------------------

export async function acknowledgeIncident(incident: AlertIncident, userId: string, now: Date = new Date()): Promise<AlertIncident> {
  if (incident.status !== 'firing') return incident;
  incident.status = 'acknowledged';
  incident.acknowledgedAt = now;
  incident.acknowledgedBy = userId;
  incident.nextEscalationAt = null;
  addTimeline(incident, now, 'acknowledged', userId);
  await (await getDb()).getRepository(AlertIncident).save(incident);
  if (incident.notifiedAt) {
    // PagerDuty-style channels close the page; others get a short note.
    await enqueue(incident, await notifiedTargets(incident.id), 'acknowledged', now);
  }
  return incident;
}

export async function resolveIncident(incident: AlertIncident, userId: string, now: Date = new Date()): Promise<AlertIncident> {
  if (incident.status === 'resolved') return incident;
  incident.status = 'resolved';
  incident.resolvedAt = now;
  incident.resolvedBy = userId;
  incident.nextEscalationAt = null;
  addTimeline(incident, now, 'resolved', `by ${userId}`);
  await (await getDb()).getRepository(AlertIncident).save(incident);
  if (incident.notifiedAt) await enqueue(incident, await notifiedTargets(incident.id), 'resolved', now);
  return incident;
}

// ---------------------------------------------------------------------------
// Leader jobs: escalation + delivery
// ---------------------------------------------------------------------------

/** Escalate unacknowledged incidents; notify silenced ones whose silence has ended. */
export async function runEscalations(now: Date = new Date()): Promise<{ escalated: number; unsilenced: number }> {
  const repo = (await getDb()).getRepository(AlertIncident);
  const firing = await repo.find({ where: { status: 'firing' } });
  let escalated = 0;
  let unsilenced = 0;
  for (const inc of firing) {
    const labels = eventLabelSet({ ...inc, labels: inc.labels } as any);
    if (inc.silencedBy && !inc.notifiedAt) {
      if (await findSilence(inc.projectId, labels, now)) continue;
      inc.silencedBy = null;
      addTimeline(inc, now, 'unsilenced', 'silence ended while still firing');
      await notifyOpen(inc, now);
      await repo.save(inc);
      unsilenced++;
      continue;
    }
    if (!inc.nextEscalationAt || new Date(inc.nextEscalationAt).getTime() > now.getTime()) continue;
    if (await findSilence(inc.projectId, labels, now)) continue; // silenced after it opened
    inc.escalationStep += 1;
    addTimeline(inc, now, 'escalated', `step ${inc.escalationStep}`);
    await notifyOpen(inc, now);
    await repo.save(inc);
    escalated++;
  }
  return { escalated, unsilenced };
}

function absoluteUrl(path: string | null): string | null {
  if (!path) return null;
  const base = alertingUrls().portal;
  return base ? `${base}${path}` : path;
}

export function messageFor(incident: AlertIncident, event: string, projectName?: string): AlertMessage {
  return {
    event: event as AlertMessage['event'],
    incidentId: incident.id,
    projectId: incident.projectId,
    projectName,
    title: incident.title,
    body: incident.body,
    severity: incident.severity,
    source: incident.source,
    dedupeKey: incident.dedupeKey,
    status: event === 'resolved' ? 'resolved' : incident.status,
    url: absoluteUrl(incident.url || `/alerting?projectId=${incident.projectId}&incident=${incident.id}`),
    environment: incident.environment,
    labels: incident.labels,
    startedAt: new Date(incident.firstSeenAt).toISOString(),
    resolvedAt: incident.resolvedAt ? new Date(incident.resolvedAt).toISOString() : null,
    escalationStep: incident.escalationStep,
  };
}

export function retryDelayMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * nodemailer errors: SMTP 5xx replies (bad recipient, auth rejected) and auth failures will
 * not succeed on retry; connection problems, timeouts and 4xx replies are retried.
 */
export function classifySmtpError(err: any): DeliveryError {
  const code = Number(err?.responseCode);
  const message = `SMTP: ${String(err?.message || err).slice(0, 300)}`;
  if (err?.code === 'EAUTH' || (Number.isFinite(code) && code >= 500)) return new DeliveryError(message, false);
  return new DeliveryError(message, true);
}

async function defaultSendEmail(to: string[], subject: string, html: string): Promise<void> {
  const smtp = await (await getDb()).getRepository(SmtpConfig).findOne({ where: { isDefault: true } });
  if (!smtp) throw new DeliveryError('No default SMTP configuration', false);
  const { sendMail } = await import('./smtp-service');
  try {
    // Bounded like the HTTP channels: an unreachable server fails within the delivery
    // timeout (and is retried with backoff) instead of nodemailer's 2-minute default.
    await sendMail(smtp as any, to, subject, html, { timeoutMs: alertingSettings().deliveryTimeoutMs });
  } catch (err) {
    throw classifySmtpError(err);
  }
}

export function defaultChannelDeps(): ChannelDeps {
  return { http: axiosHttpPost, sendEmail: defaultSendEmail, timeoutMs: alertingSettings().deliveryTimeoutMs };
}

/** Run `fn` over `items` with at most `limit` in flight; preserves start order. */
export async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

type DispatchResult = { sent: number; failed: number; retried: number };

async function deliverOne(d: AlertDelivery, now: Date, deps: ChannelDeps, maxAttempts: number, result: DispatchResult): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(AlertDelivery);
  const incident = await ds.getRepository(AlertIncident).findOne({ where: { id: d.incidentId } });
  if (!incident) {
    d.status = 'skipped';
    d.lastError = 'incident deleted';
    await repo.save(d);
    return;
  }
  const project = await ds.getRepository(Project).findOne({ where: { id: incident.projectId } });
  const msg = messageFor(incident, d.event, project?.name);
  d.attempts += 1;
  try {
    if (d.channelId) {
      const channels = ds.getRepository(AlertChannel);
      const channel = await channels.findOne({ where: { id: d.channelId } });
      if (!channel || channel.projectId !== incident.projectId || !channel.enabled) {
        d.status = 'skipped';
        d.lastError = 'channel missing or disabled';
        await repo.save(d);
        return;
      }
      if (!severityAllowed(channel.minSeverity, incident.severity)) {
        d.status = 'skipped';
        d.lastError = `below channel minimum severity ${channel.minSeverity}`;
        await repo.save(d);
        return;
      }
      try {
        await sendToChannel(channel, msg, { ...deps, now: deps.now || (() => now) });
        // Status columns only: deliveries run in parallel and must not overwrite an edit.
        await channels.update({ id: channel.id }, { lastDeliveryAt: now, lastError: null }).catch(() => {});
      } catch (err: any) {
        await channels.update({ id: channel.id }, { lastError: String(err?.message || err).slice(0, 500) }).catch(() => {});
        throw err;
      }
    } else if (d.userId) {
      await notifyUser({
        userId: d.userId,
        title: msg.event === 'resolved' ? `Resolved: ${msg.title}` : `On-call: ${msg.title}`,
        body: msg.body || undefined,
        kind: msg.event === 'resolved' ? 'success' : 'error',
        link: incident.url || `/alerting?projectId=${incident.projectId}&incident=${incident.id}`,
        metadata: { incidentId: incident.id, projectId: incident.projectId, event: msg.event },
      });
    }
    d.status = 'sent';
    d.sentAt = now;
    d.lastError = null;
    result.sent++;
  } catch (err: any) {
    const retryable = !(err instanceof DeliveryError) || err.retryable;
    d.lastError = String(err?.message || err).slice(0, 500);
    if (retryable && d.attempts < maxAttempts) {
      d.nextAttemptAt = new Date(now.getTime() + retryDelayMs(d.attempts));
      result.retried++;
    } else {
      d.status = 'failed';
      result.failed++;
    }
  }
  await repo.save(d);
}

/**
 * Send due deliveries (oldest first, bounded batch) with bounded concurrency
 * (ALERTING_DELIVERY_CONCURRENCY, default 4): every send is bounded by the delivery timeout,
 * so one unreachable channel or SMTP server holds a single slot for at most that long.
 */
export async function dispatchDeliveries(
  now: Date = new Date(),
  deps: ChannelDeps = defaultChannelDeps(),
  batch = 50,
  concurrency: number = alertingSettings().deliveryConcurrency,
): Promise<DispatchResult> {
  const repo = (await getDb()).getRepository(AlertDelivery);
  const due = (await repo.find({ where: { status: 'pending' }, order: { nextAttemptAt: 'ASC' } as any, take: batch * 4 }))
    .filter((d) => new Date(d.nextAttemptAt).getTime() <= now.getTime())
    .slice(0, batch);
  const result: DispatchResult = { sent: 0, failed: 0, retried: 0 };
  const maxAttempts = alertingSettings().maxDeliveryAttempts;
  await mapWithConcurrency(due, concurrency, async (d) => {
    try {
      await deliverOne(d, now, deps, maxAttempts, result);
    } catch (err: any) {
      // A database error on one row must not abort the others; the row stays pending.
      console.warn(`[alerting] delivery ${d.id} failed to process: ${err?.message || err}`);
    }
  });
  return result;
}
