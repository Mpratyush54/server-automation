/**
 * Session replay (#40).
 *
 * Browser (write-only, project-bound; browser tokens allowed deliberately):
 *   POST /api/sdk/replay/chunks     gzip chunk envelope (application/octet-stream) -> 202
 *        or, on page hide (#154), text/plain {"v":1,"token","chunk":"<base64 gzip>"}: the
 *        token in the body instead of the Authorization header makes it a CORS simple
 *        request (no preflight; works with navigator.sendBeacon). Same auth, limits, checks.
 *   GET  /api/sdk/replay/allowed    ?subjectId=&sessionId= -> { replayAllowed }   (consent, #47)
 *   PUT  /api/sdk/replay/consent    { subjectId, sessionId?, replayAllowed }      (setConsent, #47)
 *   Auth: the telemetry block's origin-bound browser ingest token (`plat_ingest_web_…`,
 *   Origin must match) or a browser/server SDK token. CORS: `/api/sdk/*` answers any
 *   origin without credentials (server.ts).
 *
 * Portal (project members; every session view is audited):
 *   GET    /api/projects/:projectId/replays                       list + filters
 *   GET    /api/projects/:projectId/replays/:sessionId            metadata, chunks, linked errors
 *   GET    /api/projects/:projectId/replays/:sessionId/chunks/:seq  stored chunk (gzip JSON)
 *   GET    /api/projects/:projectId/replays/:sessionId/snapshot?page=  first full DOM snapshot
 *          of a page (`:sessionId` may be `latest`); used as the heatmap background
 *   DELETE /api/projects/:projectId/replays/:sessionId            (devops+)
 */
import express, { NextFunction, Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { ProjectAccessRole } from '../entities/ProjectMember';
import {
  allowBrowserSdkToken,
  AuthenticatedRequest,
  expressAuthenticate,
  logAudit,
  sdkTokenAuth,
} from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { createLimiterStore } from '../lib/rate-limit-store';
import { normalizeSessionId, normalizeSubjectId, resolveConsent, upsertConsent } from '../lib/privacy-consent';
import { INGEST_TOKEN_PREFIX, originAllowed, verifyIngestToken } from '../lib/telemetry-tokens';
import {
  normalizePagePath,
  parseReplayChunk,
  replayIngestEnabled,
  replayLimits,
  ReplayValidationError,
  SESSION_ID_RE,
} from '../lib/replay-ingest';
import { getReplayStore } from '../lib/replay-store';
import {
  deleteReplaySession,
  getReplayChunkKey,
  getReplaySession,
  getReplaySnapshot,
  listReplaySessions,
  storeReplayChunk,
} from '../lib/replay-sessions';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ReplayRequest extends AuthenticatedRequest {
  replayEnvironment?: string;
}

const ingestLimiter = rateLimit({
  windowMs: 60_000,
  limit: () => replayLimits().rateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: createLimiterStore('replay'),
  message: { error: 'Too many replay uploads' },
});

function disabled(res: Response) {
  return res.status(404).json({ error: 'Session replay is not enabled on this platform' });
}

/** Ingest token (origin-bound, from the telemetry block) or SDK token (browser tokens opted in). */
async function replaySdkAuth(req: Request, res: Response, next: NextFunction) {
  if (!replayIngestEnabled()) return disabled(res);
  const token = String(req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (token.startsWith(INGEST_TOKEN_PREFIX)) {
    try {
      const result = await verifyIngestToken(token);
      if (result.ok === false) return res.status(401).json({ error: 'Invalid ingest token' });
      const c = result.claims;
      if (c.typ !== 'web' || !originAllowed(req.header('Origin'), c.origins)) {
        return res.status(403).json({ error: 'Invalid browser origin or token kind' });
      }
      (req as ReplayRequest).projectId = c.projectId;
      (req as ReplayRequest).replayEnvironment = c.environment;
      return next();
    } catch {
      return res.status(503).json({ error: 'Token verification unavailable' });
    }
  }
  return allowBrowserSdkToken(req, res, () => {
    void sdkTokenAuth(req, res, next);
  });
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const UNLOAD_TOKEN_MAX = 512;

/**
 * Unload envelope (#154), POST /sdk/replay/chunks only: a `text/plain` body
 * `{"v":1,"token":"…","chunk":"<base64 of the gzip chunk>"}`. Unwraps it into the same
 * request the header path sees - the token as `Authorization: Bearer …` (so replaySdkAuth
 * verifies it exactly as usual, including the Origin check for ingest tokens) and the
 * decoded gzip bytes as the body (same size limit and validation). Other content types
 * pass through untouched.
 */
function unloadEnvelope(req: Request, res: Response, next: NextFunction) {
  if (!req.is('text/plain')) return next();
  if (!replayIngestEnabled()) return disabled(res);
  if (req.header('Authorization')) {
    return res.status(400).json({ error: 'send the token in the Authorization header or in the unload envelope, not both' });
  }
  const maxChunkBytes = replayLimits().maxChunkBytes;
  const limit = Math.ceil(maxChunkBytes / 3) * 4 + 1024; // base64 + token and JSON keys
  express.text({ type: 'text/plain', limit })(req, res, (err?: any) => {
    if (err) {
      const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'replay chunk too large' : 'invalid body' });
    }
    let doc: any;
    try {
      doc = JSON.parse(typeof req.body === 'string' ? req.body : '');
    } catch {
      doc = null;
    }
    if (
      !doc ||
      typeof doc !== 'object' ||
      doc.v !== 1 ||
      typeof doc.token !== 'string' ||
      !doc.token ||
      doc.token.length > UNLOAD_TOKEN_MAX ||
      /\s/.test(doc.token) ||
      typeof doc.chunk !== 'string' ||
      doc.chunk.length % 4 !== 0 ||
      !BASE64_RE.test(doc.chunk)
    ) {
      return res.status(400).json({ error: 'invalid unload envelope' });
    }
    const body = Buffer.from(doc.chunk, 'base64');
    if (body.length > maxChunkBytes) return res.status(413).json({ error: 'replay chunk too large' });
    req.body = body;
    req.headers.authorization = `Bearer ${doc.token}`;
    return next();
  });
}

const rawChunk = (req: Request, res: Response, next: NextFunction) => {
  express.raw({ type: ['application/octet-stream', 'application/gzip'], limit: replayLimits().maxChunkBytes })(req, res, (err?: any) => {
    if (err) {
      const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'replay chunk too large' : 'invalid body' });
    }
    return next();
  });
};

/**
 * Withdrawn consent is enforced server-side too (a stale tab cannot keep uploading).
 * resolveConsent reads the Redis consent cache shared by all replicas, then Postgres.
 */
async function consentWithdrawn(projectId: string, subjectId: string | null, sessionId: string): Promise<boolean> {
  if (!subjectId) return false;
  const d = await resolveConsent(await getDb(), { projectId, subjectId, sessionId });
  return d.source === 'recorded' && !d.replayAllowed;
}

router.post('/sdk/replay/chunks', ingestLimiter, unloadEnvelope, replaySdkAuth, rawChunk, async (req: Request, res: Response) => {
  const r = req as ReplayRequest;
  const projectId = r.projectId;
  if (!projectId) return res.status(401).json({ error: 'SDK token required' });
  const store = getReplayStore();
  if (!store) return disabled(res);
  const limits = replayLimits();
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const chunk = parseReplayChunk(body, limits);
    if (await consentWithdrawn(projectId, chunk.subjectId, chunk.sessionId)) {
      return res.status(403).json({ error: 'Replay consent withdrawn' });
    }
    const out = await storeReplayChunk(await getDb(), store, {
      projectId,
      chunk,
      body,
      userAgent: req.header('User-Agent'),
      environment: r.replayEnvironment,
      limits,
    });
    // Write-only: nothing about the project or other sessions is returned.
    return res.status(out.duplicate ? 200 : 202).json({ accepted: true, duplicate: out.duplicate || undefined });
  } catch (err: any) {
    if (err instanceof ReplayValidationError) return res.status(err.status).json({ error: err.message });
    console.warn(`[replay] chunk store failed: ${err?.message || err}`);
    return res.status(503).json({ error: 'Replay storage temporarily unavailable' });
  }
});

router.get('/sdk/replay/allowed', replaySdkAuth, async (req: Request, res: Response) => {
  try {
    const projectId = (req as ReplayRequest).projectId;
    if (!projectId) return res.status(401).json({ error: 'SDK token required' });
    const subjectId = normalizeSubjectId(req.query.subjectId);
    if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
    const d = await resolveConsent(await getDb(), { projectId, subjectId, sessionId: normalizeSessionId(req.query.sessionId) });
    return res.json({ replayAllowed: d.replayAllowed });
  } catch {
    return res.status(503).json({ error: 'Consent lookup unavailable' });
  }
});

router.put('/sdk/replay/consent', replaySdkAuth, async (req: Request, res: Response) => {
  try {
    const projectId = (req as ReplayRequest).projectId;
    if (!projectId) return res.status(401).json({ error: 'SDK token required' });
    const subjectId = normalizeSubjectId(req.body?.subjectId);
    if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
    if (typeof req.body?.replayAllowed !== 'boolean') return res.status(400).json({ error: 'replayAllowed (boolean) required' });
    const sessionId = normalizeSessionId(req.body?.sessionId);
    const row = await upsertConsent(await getDb(), { projectId, subjectId, sessionId, replayAllowed: req.body.replayAllowed, source: 'sdk' });
    return res.json({ replayAllowed: row.replayAllowed });
  } catch {
    return res.status(503).json({ error: 'Consent store unavailable' });
  }
});

// ------------------------------------------------------------------ portal

async function memberAccess(req: Request, res: Response, role: ProjectAccessRole = ProjectAccessRole.VIEWER): Promise<boolean> {
  const { projectId, sessionId } = req.params;
  if (!UUID_RE.test(projectId)) {
    res.status(400).json({ error: 'Invalid project id' });
    return false;
  }
  if (sessionId !== undefined && sessionId !== 'latest' && !SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: 'Invalid session id' });
    return false;
  }
  // Recordings hold personal data: agent tokens need an explicit replays:read scope
  // (not part of the default agent scopes), on top of project access.
  const agent = (req as AuthenticatedRequest).agentToken;
  if (agent && !agent.scopes.includes('*') && !agent.scopes.includes('replays:read')) {
    res.status(403).json({ error: 'Forbidden: agent token needs the replays:read scope' });
    return false;
  }
  const access = await requireProjectAccess(req as AuthenticatedRequest, projectId, role);
  if (access.ok === false) {
    res.status(access.status).json({ error: access.error });
    return false;
  }
  return true;
}

/** Audit a replay access by the human user or agent token that made it. */
async function auditReplay(req: Request, action: string, metadata: Record<string, unknown>) {
  const r = req as AuthenticatedRequest;
  await logAudit({
    userId: r.user?.id,
    action,
    targetType: 'Project',
    targetId: req.params.projectId,
    metadata: r.agentToken ? { ...metadata, agentTokenId: r.agentToken.id, agentTokenName: r.agentToken.name } : metadata,
    ip: req.ip,
  });
}

function optNumber(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function optDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const failed = (res: Response, err: any) => {
  console.warn(`[replay] request failed: ${err?.message || err}`);
  return res.status(503).json({ error: 'Replay data temporarily unavailable' });
};

router.get('/projects/:projectId/replays', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await memberAccess(req, res))) return;
    const q = req.query;
    const errors = q.errors === 'true' || q.errors === '1' ? true : q.errors === 'false' || q.errors === '0' ? false : undefined;
    const rows = await listReplaySessions(await getDb(), req.params.projectId, {
      page: typeof q.page === 'string' ? q.page : undefined,
      hasErrors: errors,
      minDurationMs: optNumber(q.minDurationMs),
      maxDurationMs: optNumber(q.maxDurationMs),
      userId: typeof q.userId === 'string' && q.userId ? q.userId.slice(0, 128) : undefined,
      environment: typeof q.environment === 'string' && q.environment ? q.environment.slice(0, 50) : undefined,
      from: optDate(q.from),
      to: optDate(q.to),
      limit: optNumber(q.limit),
      offset: optNumber(q.offset),
    });
    return res.json({ enabled: replayIngestEnabled() && !!getReplayStore(), sessions: rows });
  } catch (err) {
    return failed(res, err);
  }
});

router.get('/projects/:projectId/replays/:sessionId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await memberAccess(req, res))) return;
    if (req.params.sessionId === 'latest') return res.status(400).json({ error: 'Invalid session id' });
    const out = await getReplaySession(await getDb(), req.params.projectId, req.params.sessionId);
    if (!out) return res.status(404).json({ error: 'Replay not found' });
    await auditReplay(req, 'replay.view', { sessionId: req.params.sessionId });
    return res.json(out);
  } catch (err) {
    return failed(res, err);
  }
});

router.get('/projects/:projectId/replays/:sessionId/chunks/:seq', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await memberAccess(req, res))) return;
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 0 || req.params.sessionId === 'latest') return res.status(400).json({ error: 'Invalid chunk' });
    const store = getReplayStore();
    if (!store) return disabled(res);
    const key = await getReplayChunkKey(await getDb(), req.params.projectId, req.params.sessionId, seq);
    if (!key) return res.status(404).json({ error: 'Chunk not found' });
    const body = await store.get(key);
    if (!body) return res.status(404).json({ error: 'Chunk expired' });
    // Chunks carry the recording itself: audited like the session view, per chunk.
    await auditReplay(req, 'replay.chunk_view', { sessionId: req.params.sessionId, seq });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).end(body);
  } catch (err) {
    return failed(res, err);
  }
});

router.get('/projects/:projectId/replays/:sessionId/snapshot', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await memberAccess(req, res))) return;
    const store = getReplayStore();
    if (!store) return disabled(res);
    const rawPage = typeof req.query.page === 'string' ? req.query.page : '';
    const page = rawPage ? normalizePagePath(rawPage.startsWith('/') || /^https?:\/\//i.test(rawPage) ? rawPage : `/${rawPage}`) : null;
    if (rawPage && !page) return res.status(400).json({ error: 'Invalid page' });
    const snap = await getReplaySnapshot(await getDb(), store, {
      projectId: req.params.projectId,
      sessionId: req.params.sessionId,
      page,
      maxRawBytes: replayLimits().maxRawBytes,
    });
    if (!snap) return res.status(404).json({ error: 'No DOM snapshot recorded for this page' });
    await auditReplay(req, 'replay.snapshot_view', { sessionId: snap.sessionId, page: snap.page });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(snap);
  } catch (err) {
    return failed(res, err);
  }
});

router.delete('/projects/:projectId/replays/:sessionId', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!(await memberAccess(req, res, ProjectAccessRole.DEVOPS))) return;
    if (req.params.sessionId === 'latest') return res.status(400).json({ error: 'Invalid session id' });
    const out = await deleteReplaySession(await getDb(), getReplayStore(), req.params.projectId, req.params.sessionId);
    await auditReplay(req, 'replay.delete', { sessionId: req.params.sessionId, objects: out.objects });
    return res.json({ deleted: true, objects: out.objects });
  } catch (err) {
    return failed(res, err);
  }
});

export default router;
