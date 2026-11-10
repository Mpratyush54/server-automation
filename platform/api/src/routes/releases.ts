import { publishAlertEvent } from '../lib/alert-events';
import { Router } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { Deployment } from '../entities/Deployment';
import { Environment } from '../entities/Environment';
import { ApiMetricModel } from '../schemas/ApiMetric';
import { ErrorDocModel } from '../schemas/ErrorDoc';
import { AuthenticatedRequest, expressAuthenticate } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { summarizeReleaseWindow, releaseDelta } from '../lib/release-comparison';
import { releaseVersion } from '../lib/release-version';
const router = Router();
router.get('/projects/:projectId/releases', expressAuthenticate, async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const rows = await (await getDb()).getRepository(Deployment).find({ where: { projectId: req.params.projectId }, order: { createdAt: 'DESC' }, take: 200 });
    return res.json(rows.filter(d => d.deployedAt).map(d => ({ ...d, release: releaseVersion(d), markerAt: d.deployedAt })));
  } catch { return res.status(503).json({ error: 'Release history unavailable' }); }
});
router.get('/projects/:projectId/releases/:id/comparison', expressAuthenticate, async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const minutes = Number(req.query.minutes ?? 15);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) return res.status(400).json({ error: 'minutes must be 1-120' });
    const ds = await getDb();
    const dep = await ds.getRepository(Deployment).findOneBy({ id: req.params.id, projectId: req.params.projectId });
    if (!dep?.deployedAt) return res.status(404).json({ error: 'Successful release marker not found' });
    const env = await ds.getRepository(Environment).findOneBy({ id: dep.environmentId!, projectId: dep.projectId });
    if (!env) return res.status(404).json({ error: 'Environment not found' });
    const at = dep.deployedAt.getTime(), width = minutes * 60000;
    const complete = Date.now() >= at + width;
    await connectMongo();
    const base = { projectId: dep.projectId, environment: String(env.name) };
    async function window(start: number, end: number) {
      const timestamp = { $gte: new Date(start), $lt: new Date(end) };
      const samples = await ApiMetricModel.find({ ...base, timestamp }).select('durationMs statusCode timestamp').limit(50001).lean();
      if (samples.length > 50000) throw new Error('Window exceeds 50000 samples; choose fewer minutes');
      const issues = await ErrorDocModel.countDocuments({ ...base, firstSeen: timestamp });
      return summarizeReleaseWindow(samples, (end-start)/1000, issues);
    }
    const before = await window(at-width, at);
    const after = await window(at, Math.min(Date.now(), at+width));
    const deltas = Object.fromEntries(['errorRate','p95LatencyMs','throughputRps','newErrorIssues'].map(k => [k, releaseDelta((before as any)[k], (after as any)[k])]));
    if (complete && before.requests >= 20 && after.requests >= 20 &&
      ((before.p95LatencyMs! > 0 && after.p95LatencyMs! > before.p95LatencyMs! * 1.2) || after.errorRate! > before.errorRate! + 1)) {
      await publishAlertEvent({ projectId: dep.projectId, environment: String(env.name), source: 'deploy', severity: 'warning',
        dedupeKey: `deploy-regression:${dep.id}`, title: `Post-deploy regression: ${releaseVersion(dep)}`,
        url: `/projects/${dep.projectId}?tab=releases`, labels: { release: releaseVersion(dep), deploymentId: dep.id } });
    }
    return res.json({ deploymentId: dep.id, release: releaseVersion(dep), minutes, complete, before, after, deltas,
      webVitalsUnavailable: 'Faro web vital query support is pending; no synthetic values are shown' });
  } catch (err: any) { return res.status(503).json({ error: err.message || 'Comparison unavailable' }); }
});
export default router;
