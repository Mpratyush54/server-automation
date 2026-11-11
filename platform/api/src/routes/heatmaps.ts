import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { allowBrowserSdkToken, sdkTokenAuth, expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { createLimiterStore } from '../lib/rate-limit-store';
import { looksLikeIngestToken, originAllowed, verifyIngestToken } from '../lib/telemetry-tokens';
import { resolveConsent } from '../lib/privacy-consent';
import { bufferHeatmapAggregates } from '../lib/heatmap-buffer';
import {
  MAX_BATCH_BYTES,
  aggregateHeatmapEvents,
  isViewport,
  listHeatmapPages,
  normalizeHeatmapPage,
  parseHeatmapRange,
  queryClickHeatmap,
  queryScrollHeatmap,
  validateHeatmapBatch,
} from '../lib/heatmaps';

/**
 * Heatmaps (Phase 4 wave B2).
 *
 *   POST /api/sdk/heatmap/events  — browser ingest (write-only, project-scoped by the credential)
 *   GET  /api/projects/:projectId/heatmaps?page=&from=&to=&viewport=&type=click|scroll
 *   GET  /api/projects/:projectId/heatmaps/pages?from=&to=&viewport=
 */
const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Per client IP, before authentication (cheap rejection of floods / token guessing). */
const ipLimiter = rateLimit({
  windowMs: 60_000,
  limit: envInt('HEATMAP_IP_RATE_LIMIT', 300),
  store: createLimiterStore('heatmap-ip'),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Per project (from the credential), after authentication: bounds DB write load per project. */
const projectLimiter = rateLimit({
  windowMs: 60_000,
  limit: envInt('HEATMAP_PROJECT_RATE_LIMIT', 3000),
  store: createLimiterStore('heatmap-project'),
  keyGenerator: (req) => `p:${(req as AuthenticatedRequest).projectId}`,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Accepts either a stored SDK token (`sdk_live_` / `sdk_test_`, server or browser kind — browser
 * opted in deliberately via allowBrowserSdkToken: this route is write-only and returns nothing
 * about the project) or the short-lived RUM ingest token from the telemetry block
 * (`plat_ingest_web_…`, origin-bound like /api/errors/rum). Either way the project comes from
 * the credential, never from the body.
 */
async function heatmapAuth(req: Request, res: Response, next: NextFunction) {
  const token = (req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (token && looksLikeIngestToken(token)) {
    try {
      const result = await verifyIngestToken(token);
      if (result.ok === false) return res.status(401).json({ error: 'Invalid ingest token' });
      const c = result.claims;
      if (c.typ === 'web' && !originAllowed(req.header('Origin'), c.origins || [])) {
        return res.status(403).json({ error: 'Origin not allowed for this browser token' });
      }
      (req as AuthenticatedRequest).projectId = c.projectId;
      return next();
    } catch {
      return res.status(503).json({ error: 'Heatmap ingest temporarily unavailable' });
    }
  }
  return sdkTokenAuth(req, res, next);
}

function doNotTrack(req: Request): boolean {
  return req.header('DNT') === '1' || req.header('Sec-GPC') === '1';
}

router.post('/sdk/heatmap/events', ipLimiter, allowBrowserSdkToken, heatmapAuth, projectLimiter, async (req, res) => {
  const projectId = (req as AuthenticatedRequest).projectId;
  if (!projectId) return res.status(401).json({ error: 'Unauthorized' });
  const raw: Buffer | undefined = (req as any).rawBody;
  const size = raw ? raw.length : Number(req.header('Content-Length') || 0);
  if (size > MAX_BATCH_BYTES) return res.status(413).json({ error: `batch larger than ${MAX_BATCH_BYTES} bytes` });
  // The browser asked not to be tracked: accept and discard (the SDK does not send in this case).
  if (doNotTrack(req)) return res.status(202).json({ accepted: 0 });
  const batch = validateHeatmapBatch(req.body);
  if (batch.ok === false) return res.status(400).json({ error: batch.error });
  try {
    const ds = await getDb();
    // #47 consent: per-subject record, else the project's analytics default.
    const consent = await resolveConsent(ds, { projectId, subjectId: batch.subjectId || '', sessionId: batch.sessionId });
    if (!consent.analyticsAllowed) return res.status(202).json({ accepted: 0, consent: false });
    // Page cap is enforced now; counts are buffered and flushed in batches (heatmap-buffer.ts).
    const { stored } = await bufferHeatmapAggregates(ds, projectId, aggregateHeatmapEvents(batch.events));
    // Write-only: never return aggregates, config or project data to the browser.
    return res.status(202).json({ accepted: stored });
  } catch (err: any) {
    console.warn(`[heatmaps] ingest failed: ${err?.message || err}`);
    res.setHeader('Retry-After', '30');
    return res.status(503).json({ error: 'Heatmap ingest temporarily unavailable' });
  }
});

async function projectQuery(req: Request, res: Response) {
  const projectId = req.params.projectId;
  if (!uuid.test(projectId)) {
    res.status(400).json({ error: 'Invalid project id' });
    return null;
  }
  const access = await requireProjectAccess(req as AuthenticatedRequest, projectId, ProjectAccessRole.VIEWER);
  if (access.ok === false) {
    res.status(access.status).json({ error: access.error });
    return null;
  }
  const range = parseHeatmapRange(req.query.from, req.query.to);
  if (range.ok === false) {
    res.status(400).json({ error: range.error });
    return null;
  }
  const vp = req.query.viewport;
  if (vp !== undefined && vp !== '' && vp !== 'all' && !isViewport(vp)) {
    res.status(400).json({ error: 'viewport must be mobile, tablet, desktop or all' });
    return null;
  }
  return { projectId, from: range.from, to: range.to, viewport: isViewport(vp) ? vp : null };
}

router.get('/projects/:projectId/heatmaps/pages', expressAuthenticate, async (req, res) => {
  try {
    const q = await projectQuery(req, res);
    if (!q) return;
    const pages = await listHeatmapPages(await getDb(), q);
    return res.json({ from: q.from, to: q.to, viewport: q.viewport || 'all', pages });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Heatmap query failed' });
  }
});

router.get('/projects/:projectId/heatmaps', expressAuthenticate, async (req, res) => {
  try {
    const q = await projectQuery(req, res);
    if (!q) return;
    const page = normalizeHeatmapPage(req.query.page);
    if (!page) return res.status(400).json({ error: 'page is required (a path such as /pricing)' });
    const type = req.query.type === undefined || req.query.type === '' ? 'click' : req.query.type;
    if (type !== 'click' && type !== 'scroll') return res.status(400).json({ error: 'type must be click or scroll' });
    const db = await getDb();
    const result = type === 'click' ? await queryClickHeatmap(db, { ...q, page }) : await queryScrollHeatmap(db, { ...q, page });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Heatmap query failed' });
  }
});

export default router;
