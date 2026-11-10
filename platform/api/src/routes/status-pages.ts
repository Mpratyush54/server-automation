/**
 * Status pages (#46): project editor APIs + public unauthenticated feed.
 *
 * Public JSON/Atom/RSS are rate-limited, cacheable, and built only from #42's
 * getProjectStatusFeed plus published incident fields (never URLs/errors/secrets).
 */
import { Router, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { StatusIncident } from '../entities/StatusIncident';
import { StatusPage } from '../entities/StatusPage';
import { publishAlertEvent } from '../lib/alert-events';
import { createLimiterStore } from '../lib/rate-limit-store';
import { requireProjectAccess } from '../lib/project-access';
import {
  appendIncidentUpdate,
  buildAtomFeed,
  buildPublicStatusPayload,
  buildRssFeed,
  getOrCreateStatusPage,
  invalidatePublicCache,
  parseIncidentCreate,
  parseIncidentUpdateBody,
  parsePagePatch,
  PUBLIC_CACHE_CONTROL,
  publicPathFor,
  readPublicCache,
  serializeAdminStatusPage,
  serializePublicIncident,
  writePublicCache,
} from '../lib/status-page';
import {
  AuthenticatedRequest, expressAuthenticate, logAudit,
} from '../middleware/auth';

const router = Router();

const safe = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((err) => {
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Status page request failed' });
    }
  });
};

const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.STATUS_PAGE_RATE_LIMIT_MAX) || 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many status page requests' },
  store: createLimiterStore('status-public'),
});

async function loadOwnedPage(projectId: string): Promise<StatusPage | null> {
  return (await getDb()).getRepository(StatusPage).findOne({ where: { projectId } });
}

// ---------------------------------------------------------------------------
// Admin: project status page settings
// ---------------------------------------------------------------------------

/** GET /api/projects/:projectId/status-page */
router.get('/projects/:projectId/status-page', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.VIEWER);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const page = await getOrCreateStatusPage(req.params.projectId, (req as AuthenticatedRequest).user?.id);
  return res.json(serializeAdminStatusPage(page));
}));

/** PUT /api/projects/:projectId/status-page */
router.put('/projects/:projectId/status-page', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const parsed = parsePagePatch(req.body);
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });

  const ds = await getDb();
  const repo = ds.getRepository(StatusPage);
  const page = await getOrCreateStatusPage(req.params.projectId, (req as AuthenticatedRequest).user?.id);
  const prevSlug = page.slug;

  if (parsed.value.slug !== undefined && parsed.value.slug !== page.slug) {
    const clash = await repo.findOne({ where: { slug: parsed.value.slug } });
    if (clash && clash.id !== page.id) return res.status(409).json({ error: 'slug already in use' });
    page.slug = parsed.value.slug;
  }
  if (parsed.value.title !== undefined) page.title = parsed.value.title;
  if (parsed.value.domain !== undefined) page.domain = parsed.value.domain;
  if (parsed.value.published !== undefined) page.published = parsed.value.published;
  if (parsed.value.componentIds !== undefined) page.componentIds = parsed.value.componentIds;
  if (parsed.value.branding) {
    page.branding = { ...(page.branding || {}), ...parsed.value.branding };
  }

  const saved = await repo.save(page);
  await invalidatePublicCache(prevSlug);
  if (saved.slug !== prevSlug) await invalidatePublicCache(saved.slug);

  await logAudit({
    userId: (req as AuthenticatedRequest).user?.id,
    action: 'status_page.updated',
    targetType: 'StatusPage',
    targetId: saved.id,
    metadata: { projectId: saved.projectId, slug: saved.slug, published: saved.published },
    ip: req.ip,
  });

  return res.json(serializeAdminStatusPage(saved));
}));

// ---------------------------------------------------------------------------
// Admin: incidents
// ---------------------------------------------------------------------------

/** GET /api/projects/:projectId/status-page/incidents */
router.get('/projects/:projectId/status-page/incidents', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.VIEWER);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const page = await loadOwnedPage(req.params.projectId);
  if (!page) return res.json({ incidents: [] });
  const rows = await (await getDb()).getRepository(StatusIncident).find({
    where: { statusPageId: page.id },
    order: { createdAt: 'DESC' },
    take: 100,
  });
  return res.json({ incidents: rows.map(serializePublicIncident) });
}));

/** POST /api/projects/:projectId/status-page/incidents */
router.post('/projects/:projectId/status-page/incidents', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const parsed = parseIncidentCreate(req.body);
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });

  const page = await getOrCreateStatusPage(req.params.projectId, (req as AuthenticatedRequest).user?.id);
  const now = new Date();
  const userId = (req as AuthenticatedRequest).user?.id || null;
  const updates = parsed.value.body
    ? [{ at: now.toISOString(), status: parsed.value.status, body: parsed.value.body, by: userId }]
    : [];

  const repo = (await getDb()).getRepository(StatusIncident);
  const saved = await repo.save(repo.create({
    statusPageId: page.id,
    projectId: page.projectId,
    title: parsed.value.title,
    status: parsed.value.status,
    impact: parsed.value.impact,
    isMaintenance: parsed.value.isMaintenance,
    updates,
    scheduledStart: parsed.value.scheduledStart || null,
    scheduledEnd: parsed.value.scheduledEnd || null,
    resolvedAt: parsed.value.status === 'resolved' ? now : null,
    createdById: userId,
  }));

  await invalidatePublicCache(page.slug);

  if (page.published && (parsed.value.impact === 'major' || parsed.value.impact === 'critical') && !parsed.value.isMaintenance) {
    await publishAlertEvent({
      projectId: page.projectId,
      source: 'status-page',
      severity: parsed.value.impact === 'critical' ? 'critical' : 'warning',
      dedupeKey: `status-incident:${saved.id}`,
      title: parsed.value.title,
      body: parsed.value.body,
      url: `/projects/${page.projectId}/status`,
      status: parsed.value.status === 'resolved' ? 'resolved' : 'firing',
      labels: { statusPageId: page.id, incidentId: saved.id, slug: page.slug },
    });
  }

  await logAudit({
    userId: userId || undefined,
    action: 'status_page.incident.created',
    targetType: 'StatusIncident',
    targetId: saved.id,
    metadata: { projectId: page.projectId, title: saved.title, status: saved.status },
    ip: req.ip,
  });

  return res.status(201).json({ incident: serializePublicIncident(saved) });
}));

/** POST /api/projects/:projectId/status-page/incidents/:id/updates */
router.post('/projects/:projectId/status-page/incidents/:id/updates', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const parsed = parseIncidentUpdateBody(req.body);
  if (parsed.ok === false) return res.status(400).json({ error: parsed.error });

  const page = await loadOwnedPage(req.params.projectId);
  if (!page) return res.status(404).json({ error: 'Status page not found' });
  const repo = (await getDb()).getRepository(StatusIncident);
  const incident = await repo.findOne({ where: { id: req.params.id, statusPageId: page.id } });
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const userId = (req as AuthenticatedRequest).user?.id || null;
  appendIncidentUpdate(incident, parsed.status, parsed.body, userId);
  const saved = await repo.save(incident);
  await invalidatePublicCache(page.slug);

  if (page.published && parsed.status === 'resolved') {
    await publishAlertEvent({
      projectId: page.projectId,
      source: 'status-page',
      severity: 'info',
      dedupeKey: `status-incident:${saved.id}`,
      title: saved.title,
      body: parsed.body,
      url: `/projects/${page.projectId}/status`,
      status: 'resolved',
      labels: { statusPageId: page.id, incidentId: saved.id, slug: page.slug },
    });
  }

  return res.json({ incident: serializePublicIncident(saved) });
}));

/** DELETE /api/projects/:projectId/status-page/incidents/:id */
router.delete('/projects/:projectId/status-page/incidents/:id', expressAuthenticate, safe(async (req, res) => {
  const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, ProjectAccessRole.DEVOPS);
  if (access.ok === false) return res.status(access.status).json({ error: access.error });
  const page = await loadOwnedPage(req.params.projectId);
  if (!page) return res.status(404).json({ error: 'Status page not found' });
  const repo = (await getDb()).getRepository(StatusIncident);
  const incident = await repo.findOne({ where: { id: req.params.id, statusPageId: page.id } });
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  await repo.delete({ id: incident.id });
  await invalidatePublicCache(page.slug);
  return res.status(204).send();
}));

// ---------------------------------------------------------------------------
// Public (no auth)
// ---------------------------------------------------------------------------

async function resolvePublic(slug: string) {
  const cached = await readPublicCache(slug);
  if (cached) return { payload: cached, fromCache: true };
  const payload = await buildPublicStatusPayload(slug);
  if (payload) await writePublicCache(slug, payload);
  return { payload, fromCache: false };
}

/** GET /api/public/status/:slug — published JSON feed. */
router.get('/public/status/:slug', publicLimiter, safe(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const { payload } = await resolvePublic(slug);
  if (!payload) return res.status(404).json({ error: 'Status page not found' });
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.json(payload);
}));

/** GET /api/public/status/:slug/atom — Atom feed of incidents. */
router.get('/public/status/:slug/atom', publicLimiter, safe(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const { payload } = await resolvePublic(slug);
  if (!payload) return res.status(404).json({ error: 'Status page not found' });
  const selfUrl = `${req.protocol}://${req.get('host')}/api/public/status/${slug}/atom`;
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.type('application/atom+xml').send(buildAtomFeed(payload, selfUrl));
}));

/** GET /api/public/status/:slug/rss — RSS feed of incidents. */
router.get('/public/status/:slug/rss', publicLimiter, safe(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const { payload } = await resolvePublic(slug);
  if (!payload) return res.status(404).json({ error: 'Status page not found' });
  const selfUrl = `${req.protocol}://${req.get('host')}/api/public/status/${slug}/rss`;
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.type('application/rss+xml').send(buildRssFeed(payload, selfUrl));
}));

export { publicPathFor };
export default router;
