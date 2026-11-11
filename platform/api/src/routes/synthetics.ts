/**
 * Synthetic monitoring API (#42).
 *
 *   GET    /synthetics/capabilities                         types, limits, browser/probe availability
 *   GET    /synthetics/templates                            editor templates
 *   GET    /projects/:projectId/synthetics/checks           list (viewer+)
 *   POST   /projects/:projectId/synthetics/checks           create (developer+, audited)
 *   GET    /projects/:projectId/synthetics/checks/:checkId  one check (viewer+)
 *   PUT    /projects/:projectId/synthetics/checks/:checkId  update (developer+, audited)
 *   DELETE /projects/:projectId/synthetics/checks/:checkId  delete (developer+, audited)
 *   POST   /projects/:projectId/synthetics/checks/:checkId/run      run now (developer+, rate limited; not browser)
 *   GET    /projects/:projectId/synthetics/checks/:checkId/results  history (viewer+)
 *   GET    /projects/:projectId/synthetics/results/:resultId/screenshot  failure screenshot (viewer+)
 *   GET    /projects/:projectId/synthetics/status-feed      public-safe aggregate for status pages (#46)
 *
 * Browser runner (CronJob pods; per-check HMAC run token, no user session). Served by
 * `runnerRouter`, which the API also exposes alone on SYNTHETICS_RUNNER_PORT (3001) so the
 * runner pods' NetworkPolicy can allow that port and nothing else of the API:
 *   GET    /synthetics/runner/checks/:checkId               definition + decrypted secrets for the runner
 *   POST   /synthetics/runner/checks/:checkId/results       report a run (+ optional PNG screenshot)
 *
 * Check secrets are write-only: responses carry `secretNames` only.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response, Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../config/database';
import { Environment } from '../entities/Environment';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { SyntheticCheck } from '../entities/SyntheticCheck';
import { SyntheticResult } from '../entities/SyntheticResult';
import { AuthenticatedRequest, expressAuthenticate, logAudit } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { createLimiterStore } from '../lib/rate-limit-store';
import {
  BROWSER_INTERVALS, CHECK_TYPES, CheckValidationError, decryptCheckSecrets, maxChecksPerProject, MAX_TIMEOUT_MS,
  mergeCheckSecrets, MIN_INTERVAL, projectIngressHosts, publicCheck, validateCheckInput, verifyRunnerToken,
} from '../lib/synthetic-checks';
import { redactSecrets } from '../lib/synthetic-assertions';
import { browserRuntime, deleteCheckResources, probesEnabled, syncCheckResources } from '../lib/synthetic-k8s';
import { executeCheck, initialNextRun, recordResult, resolveCheckAlert, syntheticStore } from '../lib/synthetic-scheduler';
import { getProjectStatusFeed } from '../lib/synthetic-status';
import { SYNTHETIC_TEMPLATES } from '../lib/synthetic-templates';
import { getUploadStore } from '../lib/upload-store';
import type { RunOutcome, StepOutcome } from '../lib/synthetic-runner';

const router = Router();
/** Runner endpoints only (token per check). Mounted on the main API and on the runner port. */
export const runnerRouter = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

function badId(res: Response, ...ids: string[]): boolean {
  if (ids.every((id) => UUID_RE.test(id))) return false;
  res.status(404).json({ error: 'Not found' });
  return true;
}

async function access(req: Request, res: Response, minRole: ProjectAccessRole): Promise<boolean> {
  const r = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId, minRole);
  if (r.ok === false) {
    res.status(r.status).json({ error: r.error });
    return false;
  }
  return true;
}

async function ingressHostsFor(projectId: string): Promise<string[]> {
  const ds = await getDb();
  return projectIngressHosts(await ds.getRepository(Environment).find({ where: { projectId } }));
}

async function loadCheck(projectId: string, checkId: string): Promise<SyntheticCheck | null> {
  const ds = await getDb();
  return ds.getRepository(SyntheticCheck).findOne({ where: { id: checkId, projectId } });
}

function handleError(res: Response, err: any, what: string) {
  if (err instanceof CheckValidationError) return res.status(400).json({ error: err.message });
  console.error(`[synthetics] ${what} failed: ${err?.message || err}`);
  return res.status(500).json({ error: `Failed to ${what}` });
}

function auditMeta(check: SyntheticCheck, extra: Record<string, unknown> = {}) {
  // Never the config itself (may reference secrets) — only identifying fields.
  return { projectId: check.projectId, name: check.name, type: check.type, enabled: check.enabled, intervalSeconds: check.intervalSeconds, ...extra };
}

const runNowLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req: Request) => `${(req as AuthenticatedRequest).user?.id || 'anon'}:${req.params.projectId}`,
  message: { error: 'Too many manual runs. Retry in a minute.' },
  store: createLimiterStore('synthetics-run'),
});

router.get('/synthetics/capabilities', expressAuthenticate, async (_req: Request, res: Response) => {
  const browser = await browserRuntime();
  res.json({
    types: CHECK_TYPES,
    minIntervalSeconds: MIN_INTERVAL,
    browserIntervals: BROWSER_INTERVALS,
    maxTimeoutMs: MAX_TIMEOUT_MS,
    maxChecksPerProject: maxChecksPerProject(),
    locations: ['local'],
    browser: browser.enabled,
    probes: probesEnabled(),
  });
});

router.get('/synthetics/templates', expressAuthenticate, (_req: Request, res: Response) => {
  res.json({ templates: SYNTHETIC_TEMPLATES });
});

router.get('/projects/:projectId/synthetics/checks', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId)) return;
  if (!(await access(req, res, ProjectAccessRole.VIEWER))) return;
  try {
    const ds = await getDb();
    const checks = await ds.getRepository(SyntheticCheck).find({ where: { projectId: req.params.projectId }, order: { name: 'ASC' } });
    res.json({ checks: checks.map(publicCheck) });
  } catch (err) {
    handleError(res, err, 'list checks');
  }
});

router.post('/projects/:projectId/synthetics/checks', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId)) return;
  if (!(await access(req, res, ProjectAccessRole.DEVELOPER))) return;
  const authReq = req as AuthenticatedRequest;
  const projectId = req.params.projectId;
  try {
    const hosts = await ingressHostsFor(projectId);
    const input = validateCheckInput(req.body, hosts);
    if (input.type === 'browser' && !(await browserRuntime()).enabled) {
      return res.status(409).json({ error: 'Browser checks need the full profile with SYNTHETICS_BROWSER=true' });
    }
    const ds = await getDb();
    const repo = ds.getRepository(SyntheticCheck);
    if (await repo.count({ where: { projectId } }) >= maxChecksPerProject()) {
      return res.status(409).json({ error: `A project can have at most ${maxChecksPerProject()} checks` });
    }
    if (input.environmentId && !(await ds.getRepository(Environment).findOne({ where: { id: input.environmentId, projectId } }))) {
      return res.status(400).json({ error: 'environmentId does not belong to this project' });
    }
    const { secrets, ...fields } = input;
    const check = repo.create({
      ...fields,
      projectId,
      secretsEncrypted: mergeCheckSecrets(null, secrets ? Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== null)) : undefined),
      nextRunAt: input.enabled ? initialNextRun(input.intervalSeconds) : null,
      lastStatus: 'unknown',
      consecutiveFailures: 0,
      alertState: 'ok',
      createdById: authReq.user?.id || null,
    });
    const saved = await repo.save(check);
    const k8s = await syncCheckResources(saved, { ingressHosts: hosts });
    await logAudit({ userId: authReq.user?.id, action: 'synthetics.create', targetType: 'synthetic_check', targetId: saved.id, metadata: auditMeta(saved), ip: req.ip });
    res.status(201).json({ check: publicCheck(saved), resources: k8s });
  } catch (err) {
    handleError(res, err, 'create check');
  }
});

router.get('/projects/:projectId/synthetics/checks/:checkId', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId, req.params.checkId)) return;
  if (!(await access(req, res, ProjectAccessRole.VIEWER))) return;
  try {
    const check = await loadCheck(req.params.projectId, req.params.checkId);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    res.json({ check: publicCheck(check) });
  } catch (err) {
    handleError(res, err, 'load check');
  }
});

router.put('/projects/:projectId/synthetics/checks/:checkId', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId, req.params.checkId)) return;
  if (!(await access(req, res, ProjectAccessRole.DEVELOPER))) return;
  const authReq = req as AuthenticatedRequest;
  try {
    const check = await loadCheck(req.params.projectId, req.params.checkId);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    const hosts = await ingressHostsFor(check.projectId);
    const input = validateCheckInput(req.body, hosts, check);
    const ds = await getDb();
    if (input.environmentId && !(await ds.getRepository(Environment).findOne({ where: { id: input.environmentId, projectId: check.projectId } }))) {
      return res.status(400).json({ error: 'environmentId does not belong to this project' });
    }
    const { secrets, ...fields } = input;
    const wasEnabled = check.enabled;
    const scheduleChanged = check.intervalSeconds !== input.intervalSeconds || (!wasEnabled && input.enabled);
    Object.assign(check, fields);
    check.secretsEncrypted = mergeCheckSecrets(check.secretsEncrypted, secrets);
    if (!input.enabled) check.nextRunAt = null;
    else if (scheduleChanged || !check.nextRunAt) check.nextRunAt = initialNextRun(input.intervalSeconds);
    if ((wasEnabled && !input.enabled) || !input.alertPolicy.enabled) {
      await resolveCheckAlert(check);
      check.alertState = 'ok';
    }
    const saved = await ds.getRepository(SyntheticCheck).save(check);
    const k8s = await syncCheckResources(saved, { ingressHosts: hosts });
    await logAudit({
      userId: authReq.user?.id, action: 'synthetics.update', targetType: 'synthetic_check', targetId: saved.id,
      metadata: auditMeta(saved, secrets ? { secretsChanged: Object.keys(secrets) } : {}), ip: req.ip,
    });
    res.json({ check: publicCheck(saved), resources: k8s });
  } catch (err) {
    handleError(res, err, 'update check');
  }
});

router.delete('/projects/:projectId/synthetics/checks/:checkId', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId, req.params.checkId)) return;
  if (!(await access(req, res, ProjectAccessRole.DEVELOPER))) return;
  const authReq = req as AuthenticatedRequest;
  try {
    const check = await loadCheck(req.params.projectId, req.params.checkId);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    const ds = await getDb();
    const results = ds.getRepository(SyntheticResult);
    const shots = await results.find({ where: { checkId: check.id }, select: { id: true, screenshotKey: true } });
    await results.delete({ checkId: check.id });
    await ds.getRepository(SyntheticCheck).delete({ id: check.id });
    for (const s of shots) if (s.screenshotKey) { try { await getUploadStore().delete(s.screenshotKey); } catch { /* best effort */ } }
    await deleteCheckResources(check.id);
    await resolveCheckAlert(check);
    await logAudit({ userId: authReq.user?.id, action: 'synthetics.delete', targetType: 'synthetic_check', targetId: check.id, metadata: auditMeta(check), ip: req.ip });
    res.json({ deleted: true });
  } catch (err) {
    handleError(res, err, 'delete check');
  }
});

router.post('/projects/:projectId/synthetics/checks/:checkId/run', expressAuthenticate, async (req: Request, res: Response, next) => {
  if (badId(res, req.params.projectId, req.params.checkId)) return;
  if (!(await access(req, res, ProjectAccessRole.DEVELOPER))) return;
  next();
}, runNowLimiter, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  try {
    const check = await loadCheck(req.params.projectId, req.params.checkId);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    if (check.type === 'browser') return res.status(409).json({ error: 'Browser checks run on their schedule in the synthetics namespace' });
    const result = await executeCheck(check);
    await logAudit({ userId: authReq.user?.id, action: 'synthetics.run', targetType: 'synthetic_check', targetId: check.id, metadata: { projectId: check.projectId, status: result.status }, ip: req.ip });
    res.json({ result });
  } catch (err) {
    handleError(res, err, 'run check');
  }
});

router.get('/projects/:projectId/synthetics/checks/:checkId/results', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId, req.params.checkId)) return;
  if (!(await access(req, res, ProjectAccessRole.VIEWER))) return;
  try {
    const check = await loadCheck(req.params.projectId, req.params.checkId);
    if (!check) return res.status(404).json({ error: 'Check not found' });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const ds = await getDb();
    const qb = ds.getRepository(SyntheticResult).createQueryBuilder('r')
      .where('r.check_id = :id', { id: check.id })
      .orderBy('r.started_at', 'DESC')
      .take(limit);
    if (typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))) {
      qb.andWhere('r.started_at < :before', { before: new Date(req.query.before) });
    }
    const rows = await qb.getMany();
    res.json({
      results: rows.map(({ screenshotKey, ...r }) => ({ ...r, hasScreenshot: !!screenshotKey })),
    });
  } catch (err) {
    handleError(res, err, 'list results');
  }
});

router.get('/projects/:projectId/synthetics/results/:resultId/screenshot', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId, req.params.resultId)) return;
  if (!(await access(req, res, ProjectAccessRole.VIEWER))) return;
  try {
    const ds = await getDb();
    const r = await ds.getRepository(SyntheticResult).findOne({ where: { id: req.params.resultId, projectId: req.params.projectId } });
    if (!r?.screenshotKey) return res.status(404).json({ error: 'No screenshot' });
    const stream = await getUploadStore().get(r.screenshotKey);
    if (!stream) return res.status(404).json({ error: 'Screenshot expired' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    stream.pipe(res);
  } catch (err) {
    handleError(res, err, 'load screenshot');
  }
});

router.get('/projects/:projectId/synthetics/status-feed', expressAuthenticate, async (req: Request, res: Response) => {
  if (badId(res, req.params.projectId)) return;
  if (!(await access(req, res, ProjectAccessRole.VIEWER))) return;
  try {
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json(await getProjectStatusFeed(req.params.projectId));
  } catch (err) {
    handleError(res, err, 'build status feed');
  }
});

// ---------------------------------------------------------------------------
// Browser runner (token per check; the runner pod has no service account token)
// ---------------------------------------------------------------------------

async function runnerCheck(req: Request, res: Response): Promise<SyntheticCheck | null> {
  const id = req.params.checkId;
  const auth = String(req.header('Authorization') || '');
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!UUID_RE.test(id) || !token || !verifyRunnerToken(id, token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  const ds = await getDb();
  const check = await ds.getRepository(SyntheticCheck).findOne({ where: { id } });
  if (!check || check.type !== 'browser') {
    res.status(404).json({ error: 'Check not found' });
    return null;
  }
  return check;
}

runnerRouter.get('/synthetics/runner/checks/:checkId', async (req: Request, res: Response) => {
  try {
    const check = await runnerCheck(req, res);
    if (!check) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!check.enabled) return res.json({ id: check.id, enabled: false });
    const ds = await getDb();
    res.json({
      id: check.id,
      enabled: true,
      type: check.type,
      timeoutMs: check.timeoutMs,
      steps: check.config.steps || [],
      secrets: decryptCheckSecrets(check.secretsEncrypted),
      allowedIngressHosts: projectIngressHosts(await ds.getRepository(Environment).find({ where: { projectId: check.projectId } })),
      // The runner refuses these names (and their subdomains) except allowedIngressHosts.
      blockedDomains: runnerBlockedDomains(),
    });
  } catch (err) {
    handleError(res, err, 'load runner check');
  }
});

/** The platform's own domain: browser checks never reach it, except the project's env hosts. */
export function runnerBlockedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const d = String(env.DOMAIN || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
  return d ? [d] : [];
}

const STEP_STATUSES = new Set(['pass', 'fail', 'skipped']);

/** Validate a runner report into a RunOutcome (bounded sizes; secrets redacted). */
export function runnerOutcome(body: any, secrets: Record<string, string>): RunOutcome {
  const status = body?.status === 'pass' ? 'pass' : 'fail';
  const clip = (v: unknown, n: number) => (typeof v === 'string' ? redactSecrets(v, secrets).slice(0, n) : undefined);
  const steps: StepOutcome[] = Array.isArray(body?.steps)
    ? body.steps.slice(0, 50).map((s: any, i: number) => ({
      name: clip(s?.name, 100) || `Step ${i + 1}`,
      status: STEP_STATUSES.has(s?.status) ? s.status : 'fail',
      latencyMs: Number.isFinite(Number(s?.latencyMs)) ? Math.max(0, Math.round(Number(s.latencyMs))) : null,
      statusCode: null,
      ...(clip(s?.error, 500) ? { error: clip(s?.error, 500) } : {}),
    }))
    : [];
  const latency = Number(body?.latencyMs);
  return {
    status,
    latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
    statusCode: null,
    error: status === 'pass' ? null : clip(body?.error, 1000) || 'Browser check failed',
    assertions: null,
    steps,
    sslExpiresAt: null,
    sslDaysRemaining: null,
  };
}

runnerRouter.post('/synthetics/runner/checks/:checkId/results', async (req: Request, res: Response) => {
  try {
    const check = await runnerCheck(req, res);
    if (!check) return;
    const secrets = decryptCheckSecrets(check.secretsEncrypted);
    const outcome = runnerOutcome(req.body, secrets);
    const startedAt = !Number.isNaN(Date.parse(req.body?.startedAt)) && Math.abs(Date.now() - Date.parse(req.body.startedAt)) < 3_600_000
      ? new Date(req.body.startedAt) : new Date();
    let screenshotKey: string | null = null;
    if (outcome.status === 'fail' && typeof req.body?.screenshot === 'string' && req.body.screenshot) {
      const buf = Buffer.from(req.body.screenshot, 'base64');
      const isPng = buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (isPng && buf.length <= MAX_SCREENSHOT_BYTES) {
        const key = `synthetics/${check.projectId}/${check.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.png`;
        const tmp = path.join(os.tmpdir(), `synthetic-${process.pid}-${Date.now()}.png`);
        try {
          fs.writeFileSync(tmp, buf, { mode: 0o600 });
          await getUploadStore().put(key, tmp, 'image/png');
          screenshotKey = key;
        } catch (err: any) {
          console.warn(`[synthetics] storing screenshot for ${check.id} failed: ${err?.message || err}`);
        } finally {
          try { fs.unlinkSync(tmp); } catch { /* moved by the local store */ }
        }
      }
    }
    const saved = await recordResult(syntheticStore(), check, outcome, { startedAt, screenshotKey });
    res.status(201).json({ id: saved.id, status: saved.status, screenshotStored: !!screenshotKey });
  } catch (err) {
    handleError(res, err, 'record runner result');
  }
});

router.use(runnerRouter);

export default router;
