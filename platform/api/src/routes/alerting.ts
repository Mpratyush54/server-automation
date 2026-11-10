/**
 * Alerting and on-call API (#43). Everything is project-scoped:
 *
 *   /projects/:projectId/alerting/{channels,monitors,slos,silences,policies,schedules,incidents}
 *   GET  /alerting/incidents            incidents of every project the caller can see
 *   GET  /alerting/status               evaluation mode
 *   POST /alerting/alertmanager/webhook Alertmanager receiver (bearer token, not a user JWT)
 *
 * Read: project viewer. Acknowledge / resolve: project developer. Configuration changes:
 * platform admin or devops (and project devops access), audited. Channel secrets are write-only.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { In } from 'typeorm';
import { getDb } from '../config/database';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest, logAudit } from '../middleware/auth';
import { UserRole, User } from '../entities/User';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { Project } from '../entities/Project';
import { requireProjectAccess, listAccessibleProjectIds } from '../lib/project-access';
import { AlertChannel } from '../entities/AlertChannel';
import { AlertMonitor } from '../entities/AlertMonitor';
import { AlertSlo } from '../entities/AlertSlo';
import { AlertSilence } from '../entities/AlertSilence';
import { AlertEscalationPolicy } from '../entities/AlertEscalationPolicy';
import { AlertOncallSchedule } from '../entities/AlertOncallSchedule';
import { AlertIncident } from '../entities/AlertIncident';
import { AlertDelivery } from '../entities/AlertDelivery';
import {
  alertExpr, OPERATORS, SEVERITIES, TRACE_SIGNALS, RESOURCES, sanitizeLabels, validateQuery, validateSlo,
  monitorDedupeKey, sloDedupeKey,
} from '../lib/alerting-rules';
import {
  normalizeChannelInput, encryptChannelSecrets, decryptChannelSecrets, publicChannel, sendToChannel, AlertMessage,
} from '../lib/alerting-channels';
import {
  acknowledgeIncident, resolveIncident, validateMatchers, validateSteps, currentOncall, emitAlertEvent, defaultChannelDeps,
} from '../lib/alerting-engine';
import { evaluateSlo, httpQuery, projectNamespaces } from '../lib/alerting-evaluator';
import { scheduleRulesSync, verifyAlertmanagerToken, mirrorSilence, expireMirroredSilence } from '../lib/alerting-k8s';
import { alertingMode, lokiRulerEnabled } from '../lib/alerting-config';
import { AlertEvent } from '../lib/alert-events';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const configRole = expressRequireRole([UserRole.DEVOPS]);

type Handler = (req: AuthenticatedRequest, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req as AuthenticatedRequest, res).catch((err: any) => {
    if (res.headersSent) return next(err);
    const status = Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : err instanceof BadRequest ? 400 : 500;
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
    if (status === 500) console.error('[alerting] route error:', err?.message || err);
  });
};

class BadRequest extends Error {
  readonly status = 400;
}
const bad = (msg: string) => new BadRequest(msg);

function str(v: unknown, field: string, max: number, required = true): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s && required) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is too long (max ${max})`);
  return s;
}

/** Project access + existence; sends the error response and returns false when denied. */
async function guard(req: AuthenticatedRequest, res: Response, minRole: ProjectAccessRole): Promise<string | null> {
  const projectId = String(req.params.projectId || '');
  if (!UUID.test(projectId)) {
    res.status(400).json({ error: 'Invalid project id' });
    return null;
  }
  const access = await requireProjectAccess(req, projectId, minRole);
  if (access.ok === false) {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  const project = await (await getDb()).getRepository(Project).findOne({ where: { id: projectId } });
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return projectId;
}

async function owned<T extends { projectId: string }>(entity: any, id: string, projectId: string): Promise<T | null> {
  if (!UUID.test(id)) return null;
  const row = await (await getDb()).getRepository(entity).findOne({ where: { id } }) as T | null;
  return row && row.projectId === projectId ? row : null;
}

function audit(req: AuthenticatedRequest, action: string, targetType: string, targetId: string | undefined, metadata: Record<string, unknown>) {
  return logAudit({ userId: req.user?.id, action, targetType, targetId, metadata, ip: req.ip });
}

async function checkPolicy(projectId: string, policyId: unknown): Promise<string | null> {
  if (policyId === undefined || policyId === null || policyId === '') return null;
  const p = await owned<AlertEscalationPolicy>(AlertEscalationPolicy, String(policyId), projectId);
  if (!p) throw bad('policyId does not belong to this project');
  return p.id;
}

// ---------------------------------------------------------------------------
// Status + cross-project incidents
// ---------------------------------------------------------------------------

router.get('/alerting/status', expressAuthenticate, wrap(async (_req, res) => {
  res.json({ mode: alertingMode(), lokiRuler: lokiRulerEnabled() });
}));

router.get('/alerting/incidents', expressAuthenticate, wrap(async (req, res) => {
  const ids = await listAccessibleProjectIds(req.user, req.agentToken);
  if (ids !== null && ids.length === 0) return res.json([]);
  const status = String(req.query.status || 'open');
  const repo = (await getDb()).getRepository(AlertIncident);
  const base = ids === null ? {} : { projectId: In(ids) };
  const where = status === 'all' ? [base] : status === 'resolved' ? [{ ...base, status: 'resolved' }] : [{ ...base, status: 'firing' }, { ...base, status: 'acknowledged' }];
  const rows = await repo.find({ where: where as any, order: { lastSeenAt: 'DESC' } as any, take: Math.min(500, Number(req.query.limit) || 200) });
  res.json(rows);
}));

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

router.get('/projects/:projectId/alerting/channels', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  const rows = await (await getDb()).getRepository(AlertChannel).find({ where: { projectId: pid } });
  res.json(rows.map((c) => publicChannel(c)));
}));

function channelFlags(req: AuthenticatedRequest, body: any, current?: AlertChannel) {
  const minSeverity = body.minSeverity === undefined ? current?.minSeverity || 'info' : String(body.minSeverity);
  if (!(SEVERITIES as readonly string[]).includes(minSeverity)) throw bad(`minSeverity must be one of ${SEVERITIES.join(', ')}`);
  let allowPrivateNetwork = current?.allowPrivateNetwork || false;
  if (body.allowPrivateNetwork !== undefined) {
    if (req.user?.role !== UserRole.ADMIN && !!body.allowPrivateNetwork !== allowPrivateNetwork) {
      throw Object.assign(new Error('Only platform admins can change allowPrivateNetwork'), { status: 403 });
    }
    allowPrivateNetwork = !!body.allowPrivateNetwork;
  }
  return { minSeverity, allowPrivateNetwork, enabled: body.enabled === undefined ? current?.enabled ?? true : !!body.enabled };
}

router.post('/projects/:projectId/alerting/channels', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const body = req.body || {};
  const name = str(body.name, 'name', 100);
  const flags = channelFlags(req, body);
  let normalized;
  try {
    normalized = await normalizeChannelInput(String(body.type || ''), body, {}, { allowPrivate: flags.allowPrivateNetwork });
  } catch (err: any) {
    throw bad(err.message);
  }
  const repo = (await getDb()).getRepository(AlertChannel);
  const saved = await repo.save(repo.create({
    projectId: pid, name, type: body.type, config: normalized.config,
    secretEnc: Object.keys(normalized.secrets).length ? encryptChannelSecrets(normalized.secrets) : null,
    ...flags, createdBy: req.user?.id || null, lastDeliveryAt: null, lastError: null,
  }));
  await audit(req, 'alerting.channel.create', 'alert_channel', saved.id, { projectId: pid, type: body.type, name });
  res.status(201).json({
    ...publicChannel(saved),
    // Shown once: receivers verify X-Platform-Signature with it.
    ...(normalized.generatedSigningSecret ? { signingSecret: normalized.generatedSigningSecret } : {}),
  });
}));

router.put('/projects/:projectId/alerting/channels/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const c = await owned<AlertChannel>(AlertChannel, req.params.id, pid);
  if (!c) return res.status(404).json({ error: 'Channel not found' });
  const body = req.body || {};
  const flags = channelFlags(req, body, c);
  let normalized;
  try {
    normalized = await normalizeChannelInput(c.type, { config: body.config ?? c.config, secrets: body.secrets }, decryptChannelSecrets(c.secretEnc), { allowPrivate: flags.allowPrivateNetwork });
  } catch (err: any) {
    throw bad(err.message);
  }
  if (body.name !== undefined) c.name = str(body.name, 'name', 100);
  c.config = normalized.config;
  c.secretEnc = Object.keys(normalized.secrets).length ? encryptChannelSecrets(normalized.secrets) : null;
  Object.assign(c, flags);
  const saved = await (await getDb()).getRepository(AlertChannel).save(c);
  await audit(req, 'alerting.channel.update', 'alert_channel', c.id, { projectId: pid, secretsChanged: !!body.secrets, fields: Object.keys(body).filter((k) => k !== 'secrets') });
  res.json({ ...publicChannel(saved), ...(normalized.generatedSigningSecret ? { signingSecret: normalized.generatedSigningSecret } : {}) });
}));

router.delete('/projects/:projectId/alerting/channels/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const c = await owned<AlertChannel>(AlertChannel, req.params.id, pid);
  if (!c) return res.status(404).json({ error: 'Channel not found' });
  await (await getDb()).getRepository(AlertChannel).delete({ id: c.id });
  await audit(req, 'alerting.channel.delete', 'alert_channel', c.id, { projectId: pid, type: c.type });
  res.json({ success: true });
}));

router.post('/projects/:projectId/alerting/channels/:id/test', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const c = await owned<AlertChannel>(AlertChannel, req.params.id, pid);
  if (!c) return res.status(404).json({ error: 'Channel not found' });
  const now = new Date();
  const msg: AlertMessage = {
    event: 'test', incidentId: '00000000-0000-0000-0000-000000000000', projectId: pid, title: 'Test notification',
    body: `Test message for channel "${c.name}"`, severity: 'info', source: 'monitor', dedupeKey: `test:${c.id}`,
    status: 'firing', startedAt: now.toISOString(),
  };
  try {
    await sendToChannel(c, msg, defaultChannelDeps());
    await audit(req, 'alerting.channel.test', 'alert_channel', c.id, { projectId: pid, ok: true });
    res.json({ ok: true });
  } catch (err: any) {
    await audit(req, 'alerting.channel.test', 'alert_channel', c.id, { projectId: pid, ok: false });
    res.status(502).json({ ok: false, error: String(err?.message || err).slice(0, 300) });
  }
}));

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

async function monitorFields(pid: string, body: any, current?: AlertMonitor): Promise<Partial<AlertMonitor>> {
  const kind = String(body.kind ?? current?.kind ?? '');
  if (!['metric', 'log', 'trace', 'resource'].includes(kind)) throw bad('kind must be metric, log, trace or resource');
  const params = body.params !== undefined ? (body.params && typeof body.params === 'object' ? body.params : {}) : current?.params || {};
  const cleanParams: Record<string, string> = {};
  if (params.environment) cleanParams.environment = str(params.environment, 'params.environment', 50);
  if (kind === 'trace') {
    if (!(TRACE_SIGNALS as readonly string[]).includes(params.signal)) throw bad(`params.signal must be one of ${TRACE_SIGNALS.join(', ')}`);
    cleanParams.signal = params.signal;
    if (params.service) cleanParams.service = str(params.service, 'params.service', 200);
  }
  if (kind === 'resource') {
    if (!(RESOURCES as readonly string[]).includes(params.resource)) throw bad(`params.resource must be one of ${RESOURCES.join(', ')}`);
    cleanParams.resource = params.resource;
  }
  let query: string | null = null;
  if (kind === 'metric' || kind === 'log') {
    try { query = validateQuery(body.query ?? current?.query); } catch (err: any) { throw bad(err.message); }
  }
  const operator = String(body.operator ?? current?.operator ?? '>');
  if (!(OPERATORS as readonly string[]).includes(operator)) throw bad(`operator must be one of ${OPERATORS.join(' ')}`);
  const threshold = Number(body.threshold ?? current?.threshold);
  if (!Number.isFinite(threshold)) throw bad('threshold must be a number');
  const forSeconds = Number(body.forSeconds ?? current?.forSeconds ?? 300);
  if (!Number.isInteger(forSeconds) || forSeconds < 0 || forSeconds > 86400) throw bad('forSeconds must be 0..86400');
  const severity = String(body.severity ?? current?.severity ?? 'warning');
  if (!(SEVERITIES as readonly string[]).includes(severity)) throw bad(`severity must be one of ${SEVERITIES.join(', ')}`);
  const fields: Partial<AlertMonitor> = {
    name: body.name !== undefined || !current ? str(body.name, 'name', 150) : current.name,
    kind: kind as AlertMonitor['kind'],
    query,
    params: cleanParams,
    operator,
    threshold,
    forSeconds,
    severity,
    labels: body.labels !== undefined ? sanitizeLabels(body.labels || {}) : current?.labels || {},
    description: body.description !== undefined ? str(body.description, 'description', 2000, false) || null : current?.description ?? null,
    enabled: body.enabled === undefined ? current?.enabled ?? true : !!body.enabled,
    policyId: body.policyId !== undefined ? await checkPolicy(pid, body.policyId) : current?.policyId ?? null,
  };
  try {
    alertExpr({ id: current?.id || 'new', projectId: pid, ...fields } as any, { namespaces: await projectNamespaces(pid) });
  } catch (err: any) {
    throw bad(err.message);
  }
  return fields;
}

router.get('/projects/:projectId/alerting/monitors', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  res.json(await (await getDb()).getRepository(AlertMonitor).find({ where: { projectId: pid } }));
}));

router.post('/projects/:projectId/alerting/monitors', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const fields = await monitorFields(pid, req.body || {});
  const repo = (await getDb()).getRepository(AlertMonitor);
  const saved = await repo.save(repo.create({ ...fields, projectId: pid, state: 'ok', pendingSince: null, lastValue: null, lastEvaluatedAt: null, lastError: null, legacyAlertId: null, createdBy: req.user?.id || null }));
  await audit(req, 'alerting.monitor.create', 'alert_monitor', saved.id, { projectId: pid, kind: saved.kind, name: saved.name });
  scheduleRulesSync(pid);
  res.status(201).json(saved);
}));

router.put('/projects/:projectId/alerting/monitors/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const m = await owned<AlertMonitor>(AlertMonitor, req.params.id, pid);
  if (!m) return res.status(404).json({ error: 'Monitor not found' });
  Object.assign(m, await monitorFields(pid, req.body || {}, m));
  const wasFiring = m.state === 'firing';
  if (!m.enabled) { m.state = 'ok'; m.pendingSince = null; }
  const saved = await (await getDb()).getRepository(AlertMonitor).save(m);
  if (wasFiring && !m.enabled) await emitAlertEvent({ projectId: pid, source: 'monitor', severity: m.severity as any, dedupeKey: monitorDedupeKey(m.id), title: m.name, body: 'Monitor disabled', status: 'resolved', labels: { platform_monitor_id: m.id } });
  await audit(req, 'alerting.monitor.update', 'alert_monitor', m.id, { projectId: pid, fields: Object.keys(req.body || {}) });
  scheduleRulesSync(pid);
  res.json(saved);
}));

router.delete('/projects/:projectId/alerting/monitors/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const m = await owned<AlertMonitor>(AlertMonitor, req.params.id, pid);
  if (!m) return res.status(404).json({ error: 'Monitor not found' });
  await (await getDb()).getRepository(AlertMonitor).delete({ id: m.id });
  await emitAlertEvent({ projectId: pid, source: 'monitor', severity: m.severity as any, dedupeKey: monitorDedupeKey(m.id), title: m.name, body: 'Monitor deleted', status: 'resolved', labels: { platform_monitor_id: m.id } });
  await audit(req, 'alerting.monitor.delete', 'alert_monitor', m.id, { projectId: pid, name: m.name });
  scheduleRulesSync(pid);
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// SLOs
// ---------------------------------------------------------------------------

async function sloFields(pid: string, body: any, current?: AlertSlo): Promise<Partial<AlertSlo>> {
  const params = body.params !== undefined ? (body.params && typeof body.params === 'object' ? body.params : {}) : current?.params || {};
  const clean: Record<string, any> = {};
  if (params.service) clean.service = str(params.service, 'params.service', 200);
  if (params.environment) clean.environment = str(params.environment, 'params.environment', 50);
  if (params.latencyMs !== undefined) clean.latencyMs = Number(params.latencyMs);
  const fields: Partial<AlertSlo> = {
    name: body.name !== undefined || !current ? str(body.name, 'name', 150) : current.name,
    sliType: String(body.sliType ?? current?.sliType ?? '') as AlertSlo['sliType'],
    errorQuery: body.errorQuery !== undefined ? body.errorQuery || null : current?.errorQuery ?? null,
    totalQuery: body.totalQuery !== undefined ? body.totalQuery || null : current?.totalQuery ?? null,
    params: clean,
    target: Number(body.target ?? current?.target),
    windowDays: Number(body.windowDays ?? current?.windowDays ?? 30),
    enabled: body.enabled === undefined ? current?.enabled ?? true : !!body.enabled,
    policyId: body.policyId !== undefined ? await checkPolicy(pid, body.policyId) : current?.policyId ?? null,
  };
  if (fields.sliType !== 'ratio') { fields.errorQuery = null; fields.totalQuery = null; }
  try {
    validateSlo({ id: 'x', projectId: pid, ...fields } as any);
  } catch (err: any) {
    throw bad(err.message);
  }
  return fields;
}

router.get('/projects/:projectId/alerting/slos', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  res.json(await (await getDb()).getRepository(AlertSlo).find({ where: { projectId: pid } }));
}));

router.post('/projects/:projectId/alerting/slos', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const fields = await sloFields(pid, req.body || {});
  const repo = (await getDb()).getRepository(AlertSlo);
  const saved = await repo.save(repo.create({ ...fields, projectId: pid, status: null, alertState: {}, createdBy: req.user?.id || null }));
  await audit(req, 'alerting.slo.create', 'alert_slo', saved.id, { projectId: pid, name: saved.name, target: saved.target });
  scheduleRulesSync(pid);
  res.status(201).json(saved);
}));

router.put('/projects/:projectId/alerting/slos/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const s = await owned<AlertSlo>(AlertSlo, req.params.id, pid);
  if (!s) return res.status(404).json({ error: 'SLO not found' });
  Object.assign(s, await sloFields(pid, req.body || {}, s));
  const saved = await (await getDb()).getRepository(AlertSlo).save(s);
  await audit(req, 'alerting.slo.update', 'alert_slo', s.id, { projectId: pid, fields: Object.keys(req.body || {}) });
  scheduleRulesSync(pid);
  res.json(saved);
}));

router.delete('/projects/:projectId/alerting/slos/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const s = await owned<AlertSlo>(AlertSlo, req.params.id, pid);
  if (!s) return res.status(404).json({ error: 'SLO not found' });
  await (await getDb()).getRepository(AlertSlo).delete({ id: s.id });
  for (const kind of ['page', 'ticket'] as const) {
    await emitAlertEvent({ projectId: pid, source: 'slo', severity: 'warning', dedupeKey: sloDedupeKey(s.id, kind), title: s.name, body: 'SLO deleted', status: 'resolved' });
  }
  await audit(req, 'alerting.slo.delete', 'alert_slo', s.id, { projectId: pid, name: s.name });
  scheduleRulesSync(pid);
  res.json({ success: true });
}));

/** SLO dashboard data: cached status, or recomputed with ?refresh=1 (no alerts are emitted). */
router.get('/projects/:projectId/alerting/slos/:id/status', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  const s = await owned<AlertSlo>(AlertSlo, req.params.id, pid);
  if (!s) return res.status(404).json({ error: 'SLO not found' });
  const status = req.query.refresh ? await evaluateSlo(s, httpQuery, new Date(), false) : s.status;
  res.json({ id: s.id, name: s.name, target: s.target, windowDays: s.windowDays, status });
}));

// ---------------------------------------------------------------------------
// Silences / maintenance windows
// ---------------------------------------------------------------------------

router.get('/projects/:projectId/alerting/silences', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  const now = Date.now();
  const rows = await (await getDb()).getRepository(AlertSilence).find({ where: { projectId: pid } });
  res.json(rows
    .filter((s) => req.query.all || new Date(s.endsAt).getTime() > now - 7 * 86400_000)
    .map((s) => ({ ...s, state: new Date(s.endsAt).getTime() <= now ? 'expired' : new Date(s.startsAt).getTime() > now ? 'pending' : 'active' })));
}));

router.post('/projects/:projectId/alerting/silences', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const body = req.body || {};
  const kind = body.kind === 'maintenance' ? 'maintenance' : 'silence';
  let matchers;
  try { matchers = validateMatchers(body.matchers); } catch (err: any) { throw bad(err.message); }
  const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
  const endsAt = body.endsAt ? new Date(body.endsAt) : new Date(startsAt.getTime() + Number(body.durationMinutes || 0) * 60_000);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw bad('startsAt / endsAt must be ISO dates');
  if (endsAt.getTime() <= startsAt.getTime() || endsAt.getTime() <= Date.now()) throw bad('endsAt must be in the future and after startsAt (or give durationMinutes)');
  if (endsAt.getTime() - startsAt.getTime() > 90 * 86400_000) throw bad('silences are limited to 90 days');
  const repo = (await getDb()).getRepository(AlertSilence);
  const saved = await repo.save(repo.create({ projectId: pid, kind, matchers, startsAt, endsAt, comment: str(body.comment, 'comment', 500, false) || null, createdBy: req.user?.id || null, alertmanagerId: null }));
  try {
    const amId = await mirrorSilence(saved);
    if (amId) { saved.alertmanagerId = amId; await repo.save(saved); }
  } catch (err: any) {
    console.warn(`[alerting] Alertmanager silence mirror failed (API still enforces it): ${err?.message || err}`);
  }
  await audit(req, 'alerting.silence.create', 'alert_silence', saved.id, { projectId: pid, kind, matchers, startsAt, endsAt });
  res.status(201).json(saved);
}));

router.delete('/projects/:projectId/alerting/silences/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const s = await owned<AlertSilence>(AlertSilence, req.params.id, pid);
  if (!s) return res.status(404).json({ error: 'Silence not found' });
  const now = new Date();
  if (new Date(s.endsAt).getTime() > now.getTime()) {
    s.endsAt = now;
    if (new Date(s.startsAt).getTime() > now.getTime()) s.startsAt = now;
    await (await getDb()).getRepository(AlertSilence).save(s);
  }
  try { await expireMirroredSilence(s.alertmanagerId); } catch (err: any) { console.warn(`[alerting] Alertmanager silence expire failed: ${err?.message || err}`); }
  await audit(req, 'alerting.silence.expire', 'alert_silence', s.id, { projectId: pid });
  res.json({ success: true, silence: s });
}));

// ---------------------------------------------------------------------------
// Escalation policies + on-call schedules
// ---------------------------------------------------------------------------

async function checkStepRefs(pid: string, steps: ReturnType<typeof validateSteps>) {
  const ds = await getDb();
  for (const s of steps) {
    for (const id of s.channelIds || []) if (!(await owned(AlertChannel, id, pid))) throw bad(`channel ${id} does not belong to this project`);
    for (const id of s.scheduleIds || []) if (!(await owned(AlertOncallSchedule, id, pid))) throw bad(`schedule ${id} does not belong to this project`);
    for (const id of s.userIds || []) if (!(await ds.getRepository(User).findOne({ where: { id } }))) throw bad(`user ${id} not found`);
  }
}

async function setDefault(pid: string, keepId: string) {
  const repo = (await getDb()).getRepository(AlertEscalationPolicy);
  for (const p of await repo.find({ where: { projectId: pid, isDefault: true } })) {
    if (p.id !== keepId) { p.isDefault = false; await repo.save(p); }
  }
}

router.get('/projects/:projectId/alerting/policies', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  res.json(await (await getDb()).getRepository(AlertEscalationPolicy).find({ where: { projectId: pid } }));
}));

router.post('/projects/:projectId/alerting/policies', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const body = req.body || {};
  let steps;
  try { steps = validateSteps(body.steps); } catch (err: any) { throw bad(err.message); }
  await checkStepRefs(pid, steps);
  const repo = (await getDb()).getRepository(AlertEscalationPolicy);
  const saved = await repo.save(repo.create({ projectId: pid, name: str(body.name, 'name', 100), isDefault: !!body.isDefault, steps }));
  if (saved.isDefault) await setDefault(pid, saved.id);
  await audit(req, 'alerting.policy.create', 'alert_policy', saved.id, { projectId: pid, steps: steps.length });
  res.status(201).json(saved);
}));

router.put('/projects/:projectId/alerting/policies/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const p = await owned<AlertEscalationPolicy>(AlertEscalationPolicy, req.params.id, pid);
  if (!p) return res.status(404).json({ error: 'Policy not found' });
  const body = req.body || {};
  if (body.steps !== undefined) {
    try { p.steps = validateSteps(body.steps); } catch (err: any) { throw bad(err.message); }
    await checkStepRefs(pid, p.steps);
  }
  if (body.name !== undefined) p.name = str(body.name, 'name', 100);
  if (body.isDefault !== undefined) p.isDefault = !!body.isDefault;
  const saved = await (await getDb()).getRepository(AlertEscalationPolicy).save(p);
  if (saved.isDefault) await setDefault(pid, saved.id);
  await audit(req, 'alerting.policy.update', 'alert_policy', p.id, { projectId: pid, fields: Object.keys(body) });
  res.json(saved);
}));

router.delete('/projects/:projectId/alerting/policies/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const p = await owned<AlertEscalationPolicy>(AlertEscalationPolicy, req.params.id, pid);
  if (!p) return res.status(404).json({ error: 'Policy not found' });
  await (await getDb()).getRepository(AlertEscalationPolicy).delete({ id: p.id });
  await audit(req, 'alerting.policy.delete', 'alert_policy', p.id, { projectId: pid });
  res.json({ success: true });
}));

function scheduleFields(body: any, current?: AlertOncallSchedule): Partial<AlertOncallSchedule> {
  const userIds = body.userIds ?? current?.userIds ?? [];
  if (!Array.isArray(userIds) || userIds.length > 50 || !userIds.every((u: any) => UUID.test(String(u)))) throw bad('userIds must be a list of user ids');
  const rotationHours = Number(body.rotationHours ?? current?.rotationHours ?? 168);
  if (!Number.isInteger(rotationHours) || rotationHours < 1 || rotationHours > 24 * 90) throw bad('rotationHours must be 1..2160');
  const startsAt = new Date(body.startsAt ?? current?.startsAt ?? new Date());
  if (Number.isNaN(startsAt.getTime())) throw bad('startsAt must be an ISO date');
  const overrides = body.overrides ?? current?.overrides ?? [];
  if (!Array.isArray(overrides) || overrides.length > 100) throw bad('overrides must be a list');
  for (const o of overrides) {
    if (!UUID.test(String(o?.userId)) || Number.isNaN(Date.parse(o?.startsAt)) || Number.isNaN(Date.parse(o?.endsAt)) || Date.parse(o.endsAt) <= Date.parse(o.startsAt)) {
      throw bad('each override needs userId, startsAt and a later endsAt');
    }
  }
  return {
    name: body.name !== undefined || !current ? str(body.name, 'name', 100) : current.name,
    userIds: userIds.map(String),
    rotationHours,
    startsAt,
    overrides: overrides.map((o: any) => ({ userId: String(o.userId), startsAt: new Date(o.startsAt).toISOString(), endsAt: new Date(o.endsAt).toISOString() })),
  };
}

async function checkUsers(ids: string[]) {
  const repo = (await getDb()).getRepository(User);
  for (const id of ids) if (!(await repo.findOne({ where: { id } }))) throw bad(`user ${id} not found`);
}

router.get('/projects/:projectId/alerting/schedules', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  const now = new Date();
  const rows = await (await getDb()).getRepository(AlertOncallSchedule).find({ where: { projectId: pid } });
  res.json(rows.map((s) => ({ ...s, onCallUserId: currentOncall(s, now) })));
}));

router.post('/projects/:projectId/alerting/schedules', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const fields = scheduleFields(req.body || {});
  await checkUsers([...(fields.userIds || []), ...(fields.overrides || []).map((o) => o.userId)]);
  const repo = (await getDb()).getRepository(AlertOncallSchedule);
  const saved = await repo.save(repo.create({ ...fields, projectId: pid }));
  await audit(req, 'alerting.schedule.create', 'alert_schedule', saved.id, { projectId: pid, users: saved.userIds.length });
  res.status(201).json({ ...saved, onCallUserId: currentOncall(saved, new Date()) });
}));

router.put('/projects/:projectId/alerting/schedules/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const s = await owned<AlertOncallSchedule>(AlertOncallSchedule, req.params.id, pid);
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  Object.assign(s, scheduleFields(req.body || {}, s));
  await checkUsers([...s.userIds, ...s.overrides.map((o) => o.userId)]);
  const saved = await (await getDb()).getRepository(AlertOncallSchedule).save(s);
  await audit(req, 'alerting.schedule.update', 'alert_schedule', s.id, { projectId: pid, fields: Object.keys(req.body || {}) });
  res.json({ ...saved, onCallUserId: currentOncall(saved, new Date()) });
}));

router.delete('/projects/:projectId/alerting/schedules/:id', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const s = await owned<AlertOncallSchedule>(AlertOncallSchedule, req.params.id, pid);
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  await (await getDb()).getRepository(AlertOncallSchedule).delete({ id: s.id });
  await audit(req, 'alerting.schedule.delete', 'alert_schedule', s.id, { projectId: pid });
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

router.get('/projects/:projectId/alerting/incidents', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  const status = String(req.query.status || 'open');
  const rows = await (await getDb()).getRepository(AlertIncident).find({ where: { projectId: pid }, order: { lastSeenAt: 'DESC' } as any, take: 1000 });
  const filtered = rows.filter((i) => status === 'all' || (status === 'resolved' ? i.status === 'resolved' : i.status !== 'resolved'));
  res.json(filtered.slice(0, Math.min(500, Number(req.query.limit) || 200)));
}));

router.get('/projects/:projectId/alerting/incidents/:id', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.VIEWER);
  if (!pid) return;
  const inc = await owned<AlertIncident>(AlertIncident, req.params.id, pid);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const deliveries = await (await getDb()).getRepository(AlertDelivery).find({ where: { incidentId: inc.id } });
  res.json({ ...inc, deliveries });
}));

router.post('/projects/:projectId/alerting/incidents/:id/ack', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVELOPER);
  if (!pid) return;
  const inc = await owned<AlertIncident>(AlertIncident, req.params.id, pid);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const out = await acknowledgeIncident(inc, req.user!.id);
  await audit(req, 'alerting.incident.ack', 'alert_incident', inc.id, { projectId: pid });
  res.json(out);
}));

router.post('/projects/:projectId/alerting/incidents/:id/resolve', expressAuthenticate, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVELOPER);
  if (!pid) return;
  const inc = await owned<AlertIncident>(AlertIncident, req.params.id, pid);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const out = await resolveIncident(inc, req.user!.id);
  await audit(req, 'alerting.incident.resolve', 'alert_incident', inc.id, { projectId: pid });
  res.json(out);
}));

/** Fire (or resolve) a test alert through the whole pipeline (routing, silences, channels). */
router.post('/projects/:projectId/alerting/test-event', expressAuthenticate, configRole, wrap(async (req, res) => {
  const pid = await guard(req, res, ProjectAccessRole.DEVOPS);
  if (!pid) return;
  const body = req.body || {};
  const key = str(body.key || 'default', 'key', 100);
  const event: AlertEvent = {
    projectId: pid,
    source: 'monitor',
    severity: (SEVERITIES as readonly string[]).includes(body.severity) ? body.severity : 'warning',
    dedupeKey: `test:${key}`,
    title: str(body.title || 'Test alert', 'title', 200),
    body: 'Raised from the portal / API to test alert routing.',
    status: body.status === 'resolved' ? 'resolved' : 'firing',
    url: `/alerting?projectId=${pid}`,
    labels: { test: 'true' },
  };
  await emitAlertEvent(event);
  await audit(req, 'alerting.test_event', 'project', pid, { key, status: event.status });
  res.status(202).json({ accepted: true, dedupeKey: event.dedupeKey, status: event.status });
}));

// ---------------------------------------------------------------------------
// Alertmanager receiver (full profile)
// ---------------------------------------------------------------------------

/** Alertmanager webhook v4 -> AlertEvents. Only alerts of rules the API generated are accepted. */
router.post('/alerting/alertmanager/webhook', wrap(async (req, res) => {
  if (!verifyAlertmanagerToken(req.get('authorization'))) return res.status(401).json({ error: 'Unauthorized' });
  const alerts = Array.isArray(req.body?.alerts) ? req.body.alerts.slice(0, 500) : [];
  const ds = await getDb();
  let accepted = 0;
  for (const a of alerts) {
    const labels: Record<string, string> = a?.labels || {};
    const ann: Record<string, string> = a?.annotations || {};
    const projectId = String(labels.project || '');
    if (!UUID.test(projectId)) continue;
    let dedupeKey: string;
    let source: AlertEvent['source'];
    let tab: string;
    if (labels.platform_source === 'monitor' && UUID.test(labels.platform_monitor_id || '')) {
      const m = await ds.getRepository(AlertMonitor).findOne({ where: { id: labels.platform_monitor_id } });
      if (!m || m.projectId !== projectId) continue;
      dedupeKey = monitorDedupeKey(m.id);
      source = 'monitor';
      tab = 'monitors';
    } else if (labels.platform_source === 'slo' && UUID.test(labels.platform_slo_id || '') && ['page', 'ticket'].includes(labels.platform_slo_alert)) {
      const s = await ds.getRepository(AlertSlo).findOne({ where: { id: labels.platform_slo_id } });
      if (!s || s.projectId !== projectId) continue;
      dedupeKey = sloDedupeKey(s.id, labels.platform_slo_alert as 'page' | 'ticket');
      source = 'slo';
      tab = 'slos';
    } else {
      continue;
    }
    const passLabels: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) if (!['namespace', 'project', 'alertname', 'severity', 'prometheus'].includes(k)) passLabels[k] = String(v);
    await emitAlertEvent({
      projectId,
      source,
      severity: (SEVERITIES as readonly string[]).includes(labels.severity) ? labels.severity as AlertEvent['severity'] : 'warning',
      dedupeKey,
      title: String(ann.summary || labels.alertname || dedupeKey),
      body: ann.description ? String(ann.description) : undefined,
      url: `/alerting?projectId=${projectId}&tab=${tab}`,
      status: a?.status === 'resolved' ? 'resolved' : 'firing',
      labels: passLabels,
      at: a?.status === 'resolved' ? a?.endsAt : a?.startsAt,
    });
    accepted++;
  }
  res.json({ accepted });
}));

export default router;
