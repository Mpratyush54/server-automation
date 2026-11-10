import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { allowBrowserSdkToken, sdkTokenAuth, expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess, userCanAccessProject } from '../lib/project-access';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { createLimiterStore } from '../lib/rate-limit-store';
import { validateErrorEvent } from '../lib/error-tracking';
import { ingestTelemetry, TelemetryBackpressureError } from '../lib/telemetry-queue';
import { uploadSourceMap, symbolicate } from '../lib/error-sourcemaps';
import { originAllowed, verifyIngestToken } from '../lib/telemetry-tokens';
import { publishAlertEvent } from '../lib/alert-events';

const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limiter = rateLimit({ windowMs: 60000, limit: 120, store: createLimiterStore('errors'), standardHeaders: true, legacyHeaders: false });
async function access(req: Request, res: Response, write = false): Promise<boolean> {
  if (!uuid.test(req.params.id)) { res.status(400).json({ error: 'Invalid project id' }); return false; }
  const a = await requireProjectAccess(req as AuthenticatedRequest, req.params.id, write ? ProjectAccessRole.DEVELOPER : ProjectAccessRole.VIEWER);
  if (a.ok === false) { res.status(a.status).json({ error: a.error }); return false; }
  return true;
}
function failed(res: Response, err: any) {
  if (err instanceof TelemetryBackpressureError) { res.setHeader('Retry-After', err.retryAfterSeconds); return res.status(429).json({ error: 'Error queue busy' }); }
  return res.status(503).json({ error: 'Error tracking temporarily unavailable' });
}
async function ingest(req: Request, res: Response, projectId: string, environment?: string) {
  let event;
  try { event = validateErrorEvent({ ...req.body, ...(environment ? { environment } : {}) }); }
  catch (e: any) { return res.status(400).json({ error: e.message }); }
  try {
    await ingestTelemetry('errors', projectId, { projectId, event });
    // Write-only endpoint: never expose issue, event, or configuration data to browsers.
    return res.status(202).json({ accepted: true });
  } catch (e) { return failed(res, e); }
}
router.post('/sdk/errors', limiter, allowBrowserSdkToken, sdkTokenAuth, (req, res) => ingest(req, res, (req as AuthenticatedRequest).projectId!));
// RUM/Faro mirror uses the existing short-lived, origin-bound ingest credential.
router.post('/errors/rum', limiter, async (req, res) => {
  try {
    const result = await verifyIngestToken((req.header('Authorization') || '').replace(/^Bearer\s+/i, ''));
    if (result.ok === false) return res.status(401).json({ error: 'Invalid ingest token' });
    const c = result.claims;
    if (c.typ !== 'web' || !originAllowed(req.header('Origin'), c.origins)) return res.status(403).json({ error: 'Invalid browser origin or token kind' });
    return ingest(req, res, c.projectId, c.environment);
  } catch (e) { return failed(res, e); }
});

router.post('/projects/:id/releases/:version/sourcemaps', limiter, expressAuthenticate, async (req, res) => {
  try {
    if (!uuid.test(req.params.id) || req.params.version.length > 200) return res.status(400).json({ error: 'Invalid project/release' });
    const auth = req as AuthenticatedRequest;
    // CI agents require an explicit project-bound grant. Global projects:read is insufficient.
    if (auth.agentToken) {
      if (!auth.agentToken.scopes.includes(`errors:sourcemaps:${req.params.id}`)) return res.status(403).json({ error: 'Missing project source-map upload scope' });
    } else if (!(await access(req, res, true))) return;
    if (typeof req.body?.file !== 'string' || !req.body.file || req.body.file.length > 2048) return res.status(400).json({ error: 'file is required' });
    try { const { parseSourceMap } = await import('../lib/error-sourcemaps'); parseSourceMap(req.body.map); }
    catch (e: any) { return res.status(400).json({ error: e.message }); }
    await uploadSourceMap(req.params.id, req.params.version, req.body.file, req.body.map);
    return res.status(201).json({ uploaded: true });
  } catch (e) { return failed(res, e); }
});

router.get('/projects/:id/errors', expressAuthenticate, async (req, res) => {
  try {
    if (!(await access(req, res))) return;
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const offset = Math.max(0, Math.min(1000000, Number(req.query.offset) || 0));
    const rows = await (await getDb()).query(`SELECT * FROM error_issues WHERE project_id=$1
      AND ($2::text IS NULL OR environment=$2) AND ($3::text IS NULL OR release_counts ? $3)
      AND ($4::text IS NULL OR status=$4) ORDER BY last_seen DESC LIMIT $5 OFFSET $6`,
    [req.params.id, req.query.environment || null, req.query.release || null, req.query.status || null, limit, offset]);
    return res.json(rows);
  } catch (e) { return failed(res, e); }
});

router.get('/projects/:id/errors/:issueId', expressAuthenticate, async (req, res) => {
  try {
    if (!(await access(req, res))) return;
    if (!uuid.test(req.params.issueId)) return res.status(400).json({ error: 'Invalid issue id' });
    const db = await getDb();
    const [issue] = await db.query('SELECT * FROM error_issues WHERE project_id=$1 AND id=$2', [req.params.id, req.params.issueId]);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    const events = await db.query(`SELECT id, received_at, payload FROM error_events WHERE project_id=$1 AND issue_id=$2
      AND ($3::text IS NULL OR payload->>'release'=$3) ORDER BY received_at DESC LIMIT 20`, [req.params.id, issue.id, req.query.release || null]);
    for (const e of events) e.symbolicated = (await symbolicate(req.params.id, e.payload)).frames;
    return res.json({ issue, events });
  } catch (e) { return failed(res, e); }
});

router.patch('/projects/:id/errors/:issueId', expressAuthenticate, async (req, res) => {
  try {
    if (!(await access(req, res, true))) return;
    if (!uuid.test(req.params.issueId)) return res.status(400).json({ error: 'Invalid issue id' });
    const { status, assigneeId } = req.body || {};
    if ((status !== undefined && !['open', 'resolved', 'ignored'].includes(status)) ||
        (assigneeId !== undefined && assigneeId !== null && !uuid.test(assigneeId)) ||
        (status === undefined && assigneeId === undefined)) return res.status(400).json({ error: 'Invalid triage update' });
    const db = await getDb();
    if (assigneeId) {
      const [user] = await db.query('SELECT id,role FROM users WHERE id=$1', [assigneeId]);
      if (!user || !(await userCanAccessProject(req.params.id, user))) return res.status(400).json({ error: 'Assignee must have project access' });
    }
    const [issue] = await db.query(`UPDATE error_issues SET status=COALESCE($3,status),
      assignee_id=CASE WHEN $4 THEN $5::uuid ELSE assignee_id END,
      resolved_release=CASE WHEN $3='resolved' THEN latest_release ELSE resolved_release END,
      regression=CASE WHEN $3='resolved' THEN false ELSE regression END
      WHERE project_id=$1 AND id=$2 RETURNING *`, [req.params.id, req.params.issueId, status || null, assigneeId !== undefined, assigneeId || null]);
    if (!issue) return res.status(404).json({ error: 'Issue not found' });
    if (status === 'resolved') await publishAlertEvent({ projectId: req.params.id, environment: issue.environment,
      source: 'error-tracking', severity: 'info', dedupeKey: `error:${issue.fingerprint}:${issue.environment}`,
      title: `Resolved: ${issue.title}`, status: 'resolved' });
    return res.json(issue);
  } catch (e) { return failed(res, e); }
});
export default router;
