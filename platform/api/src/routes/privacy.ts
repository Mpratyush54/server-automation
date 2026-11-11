import { Router, RequestHandler } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { TelemetryPrivacySettings } from '../entities/TelemetryPrivacySettings';
import {
  expressAuthenticate,
  sdkOrUserAuthenticate,
  allowBrowserSdkToken,
  sdkTokenAuth,
  logAudit,
  AuthenticatedRequest,
  sdkProjectMatches,
} from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { builtinRulesPublic } from '../lib/pii-scrub';
import {
  getOrCreatePrivacySettings,
  parseConsentDefaultsPatch,
  parseRetentionPatch,
  parseScrubRulesPatch,
  publicPrivacySettings,
  applyRetentionPatch,
  defaultRetentionDays,
} from '../lib/privacy-settings';
import { requestLokiRetentionReconcile } from '../lib/loki-retention';
import {
  isReplayAllowed,
  normalizeSubjectId,
  resolveConsent,
  upsertConsent,
} from '../lib/privacy-consent';
import { runGdprDelete } from '../lib/gdpr-delete';
import { DEFAULT_CONSENT } from '../entities/TelemetryPrivacySettings';

const router = Router();

const safe = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Privacy request failed' });
    }
  });
};

/** GET /api/privacy/defaults — cluster-wide defaults (no auth; public catalogue). */
router.get('/privacy/defaults', (_req, res) => {
  res.json({
    retentionDays: defaultRetentionDays(),
    retentionScope: { logs: 'project', replays: 'project', errors: 'project', traces: 'cluster', profiles: 'cluster' },
    consent: { ...DEFAULT_CONSENT },
    builtinScrubRules: builtinRulesPublic(true),
    replayObjectPrefix: 'replays/{projectId}/user/{userId}/ | replays/{projectId}/session/{sessionId}/',
  });
});

/** GET /api/projects/:projectId/privacy */
router.get('/projects/:projectId/privacy', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.VIEWER);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const ds = await getDb();
  const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const settings = await getOrCreatePrivacySettings(ds, project.id);
  return res.json({
    ...publicPrivacySettings(settings),
    builtinScrubRules: builtinRulesPublic(settings.scrubIps),
  });
}));

/** PUT /api/projects/:projectId/privacy/scrubbing */
router.put('/projects/:projectId/privacy/scrubbing', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const parsed = parseScrubRulesPatch(req.body);
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
  const ds = await getDb();
  const settings = await getOrCreatePrivacySettings(ds, req.params.projectId);
  if (req.body?.rules !== undefined) settings.scrubRules = parsed.rules;
  if (parsed.scrubIps !== undefined) settings.scrubIps = parsed.scrubIps;
  settings.updatedById = (req as AuthenticatedRequest).user?.id || null;
  const saved = await ds.getRepository(TelemetryPrivacySettings).save(settings);
  await logAudit({
    userId: (req as AuthenticatedRequest).user?.id,
    action: 'privacy.scrubbing.updated',
    targetType: 'Project',
    targetId: req.params.projectId,
    metadata: { ruleCount: saved.scrubRules?.length || 0, scrubIps: saved.scrubIps },
    ip: req.ip,
  });
  return res.json(publicPrivacySettings(saved));
}));

/** PUT /api/projects/:projectId/privacy/retention */
router.put('/projects/:projectId/privacy/retention', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const parsed = parseRetentionPatch(req.body);
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
  const ds = await getDb();
  const settings = await getOrCreatePrivacySettings(ds, req.params.projectId);
  const previousLogs = settings.retentionDays?.logs ?? null;
  settings.retentionDays = applyRetentionPatch(settings.retentionDays, parsed.value);
  settings.updatedById = (req as AuthenticatedRequest).user?.id || null;
  const saved = await ds.getRepository(TelemetryPrivacySettings).save(settings);
  await logAudit({
    userId: (req as AuthenticatedRequest).user?.id,
    action: 'privacy.retention.updated',
    targetType: 'Project',
    targetId: req.params.projectId,
    metadata: { retentionDays: saved.retentionDays },
    ip: req.ip,
  });
  // Per-project logs retention is enforced by Loki: push the change now (best effort;
  // the periodic reconcile retries).
  if ((saved.retentionDays?.logs ?? null) !== previousLogs) requestLokiRetentionReconcile();
  return res.json(publicPrivacySettings(saved));
}));

/** PUT /api/projects/:projectId/privacy/consent-defaults */
router.put('/projects/:projectId/privacy/consent-defaults', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const parsed = parseConsentDefaultsPatch(req.body);
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });
  const ds = await getDb();
  const settings = await getOrCreatePrivacySettings(ds, req.params.projectId);
  settings.consentDefaults = parsed.value;
  settings.updatedById = (req as AuthenticatedRequest).user?.id || null;
  const saved = await ds.getRepository(TelemetryPrivacySettings).save(settings);
  await logAudit({
    userId: (req as AuthenticatedRequest).user?.id,
    action: 'privacy.consent_defaults.updated',
    targetType: 'Project',
    targetId: req.params.projectId,
    metadata: { consentDefaults: saved.consentDefaults },
    ip: req.ip,
  });
  return res.json(publicPrivacySettings(saved));
}));

/** GET /api/projects/:projectId/privacy/consent?subjectId=&sessionId= */
router.get('/projects/:projectId/privacy/consent', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.VIEWER);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const subjectId = normalizeSubjectId(req.query.subjectId);
  if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
  const ds = await getDb();
  const decision = await resolveConsent(ds, {
    projectId: req.params.projectId,
    subjectId,
    sessionId: String(req.query.sessionId || ''),
  });
  return res.json(decision);
}));

/** PUT /api/projects/:projectId/privacy/consent — portal/API record */
router.put('/projects/:projectId/privacy/consent', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const subjectId = normalizeSubjectId(req.body?.subjectId);
  if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
  const ds = await getDb();
  const row = await upsertConsent(ds, {
    projectId: req.params.projectId,
    subjectId,
    sessionId: req.body?.sessionId,
    replayAllowed: req.body?.replayAllowed,
    analyticsAllowed: req.body?.analyticsAllowed,
    source: 'portal',
  });
  await logAudit({
    userId: (req as AuthenticatedRequest).user?.id,
    action: 'privacy.consent.updated',
    targetType: 'Project',
    targetId: req.params.projectId,
    metadata: { subjectId, sessionId: row.sessionId, replayAllowed: row.replayAllowed },
    ip: req.ip,
  });
  return res.json({
    subjectId: row.subjectId,
    sessionId: row.sessionId,
    replayAllowed: row.replayAllowed,
    analyticsAllowed: row.analyticsAllowed,
    source: row.source,
    updatedAt: row.updatedAt,
  });
}));

/**
 * POST /api/projects/:projectId/privacy/gdpr-delete
 * Body: { userId?, sessionId?, email? } — at least userId or sessionId.
 */
router.post('/projects/:projectId/privacy/gdpr-delete', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.OWNER);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const ds = await getDb();
  try {
    const result = await runGdprDelete(ds, {
      projectId: req.params.projectId,
      userId: req.body?.userId,
      sessionId: req.body?.sessionId,
      email: req.body?.email,
    });
    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'privacy.gdpr_delete',
      targetType: 'Project',
      targetId: req.params.projectId,
      metadata: {
        userId: result.userId,
        sessionId: result.sessionId,
        emailHash: result.emailHash,
        deleted: result.deleted,
        warnings: result.warnings,
      },
      ip: req.ip,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message || 'delete failed' });
  }
}));

/**
 * SDK consent hooks for #40 (browser tokens allowed; write-only / read consent).
 * PUT /api/sdk/privacy/consent  { subjectId, sessionId?, replayAllowed?, analyticsAllowed? }
 * GET /api/sdk/privacy/consent?subjectId=&sessionId=
 */
router.put(
  '/sdk/privacy/consent',
  allowBrowserSdkToken,
  sdkOrUserAuthenticate,
  safe(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const projectId = authReq.projectId || (authReq.sdkToken ? undefined : req.body?.projectId);
    if (authReq.sdkToken) {
      if (!authReq.projectId) return res.status(401).json({ error: 'SDK token required' });
      if (!sdkProjectMatches(authReq, req.body?.projectId)) {
        return res.status(403).json({ error: 'project mismatch' });
      }
    }
    const pid = authReq.projectId || projectId;
    if (!pid) return res.status(400).json({ error: 'project scope required' });
    if (!authReq.sdkToken) {
      const access = await requireProjectAccess(authReq, String(pid), ProjectAccessRole.DEVOPS);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
    }
    const subjectId = normalizeSubjectId(req.body?.subjectId);
    if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
    const ds = await getDb();
    const row = await upsertConsent(ds, {
      projectId: String(pid),
      subjectId,
      sessionId: req.body?.sessionId,
      replayAllowed: req.body?.replayAllowed,
      analyticsAllowed: req.body?.analyticsAllowed,
      source: authReq.sdkToken ? 'sdk' : 'api',
    });
    return res.json({
      subjectId: row.subjectId,
      sessionId: row.sessionId,
      replayAllowed: row.replayAllowed,
      analyticsAllowed: row.analyticsAllowed,
    });
  }),
);

router.get(
  '/sdk/privacy/consent',
  allowBrowserSdkToken,
  sdkOrUserAuthenticate,
  safe(async (req, res) => {
    const authReq = req as AuthenticatedRequest;
    const pid = authReq.projectId || String(req.query.projectId || '');
    if (!pid) return res.status(400).json({ error: 'project scope required' });
    if (authReq.sdkToken && !sdkProjectMatches(authReq, req.query.projectId)) {
      return res.status(403).json({ error: 'project mismatch' });
    }
    if (!authReq.sdkToken) {
      const access = await requireProjectAccess(authReq, pid, ProjectAccessRole.VIEWER);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
    }
    const subjectId = normalizeSubjectId(req.query.subjectId);
    if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
    const ds = await getDb();
    const decision = await resolveConsent(ds, {
      projectId: pid,
      subjectId,
      sessionId: String(req.query.sessionId || ''),
    });
    return res.json({
      replayAllowed: decision.replayAllowed,
      analyticsAllowed: decision.analyticsAllowed,
      source: decision.source,
    });
  }),
);

/** Convenience: boolean gate used by #40 before starting rrweb. */
router.get(
  '/sdk/privacy/replay-allowed',
  allowBrowserSdkToken,
  sdkTokenAuth,
  safe(async (req, res) => {
    const projectId = (req as AuthenticatedRequest).projectId;
    if (!projectId) return res.status(401).json({ error: 'SDK token required' });
    const subjectId = normalizeSubjectId(req.query.subjectId);
    if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
    const ds = await getDb();
    const allowed = await isReplayAllowed(ds, {
      projectId,
      subjectId,
      sessionId: String(req.query.sessionId || ''),
    });
    return res.json({ replayAllowed: allowed });
  }),
);

export default router;
