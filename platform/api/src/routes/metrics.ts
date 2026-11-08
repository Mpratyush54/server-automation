import { requireProjectAccess, listAccessibleProjectIds } from '../lib/project-access';
import { Router, Request, Response } from 'express';
import { connectMongo } from '../config/mongoose';
import { getDb } from '../config/database';
import { MetricsRawModel } from '../schemas/MetricsRaw';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';
import { UserRole } from '../entities/User';
import { renderJobMetrics } from '../lib/job-metrics';
import { projectIdMongoFilter, resolveProjectRef } from '../lib/project-resolve';

const router = Router();

router.get('/metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    await connectMongo();
    const ds = await getDb();
    const auth = req as AuthenticatedRequest;
    const ids = await listAccessibleProjectIds(auth.user, auth.agentToken);
    const filter: Record<string, any> = {};
    if (projectId) {
      const ref = await resolveProjectRef(ds, String(projectId));
      if (!ref) return res.status(404).json({ error: 'Project not found' });
      const access = await requireProjectAccess(auth, ref.id);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
      Object.assign(filter, await projectIdMongoFilter(ds, ref.id));
    } else if (ids !== null) {
      filter.$or = ids.length ? await Promise.all(ids.map(id => projectIdMongoFilter(ds, id))) : [{ projectId: { $in: [] } }];
    }


    const raw = await MetricsRawModel.find(filter).sort({ timestamp: -1 }).limit(100).lean();
    return res.json(raw);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/metrics/aggregated', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    await connectMongo();
    const ds = await getDb();
    const auth = req as AuthenticatedRequest;
    const ids = await listAccessibleProjectIds(auth.user, auth.agentToken);
    const filter: Record<string, any> = {};
    if (projectId) {
      const ref = await resolveProjectRef(ds, String(projectId));
      if (!ref) return res.status(404).json({ error: 'Project not found' });
      const access = await requireProjectAccess(auth, ref.id);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
      Object.assign(filter, await projectIdMongoFilter(ds, ref.id));
    } else if (ids !== null) {
      filter.$or = ids.length ? await Promise.all(ids.map(id => projectIdMongoFilter(ds, id))) : [{ projectId: { $in: [] } }];
    }


    const raw = await MetricsRawModel.find(filter).sort({ timestamp: -1 }).limit(20).lean();
    if (raw.length === 0) return res.json({ cpuAvg: 0, memoryAvg: 0, errorRate: 0 });

    const cpuSum = raw.reduce((acc, r) => acc + (r.cpuPct || 0), 0);
    const memSum = raw.reduce((acc, r) => acc + (r.memoryMb || 0), 0);
    const errSum = raw.reduce((acc, r) => acc + (r.errors5xx || 0), 0);

    return res.json({
      cpuAvg: cpuSum / raw.length,
      memoryAvg: memSum / raw.length,
      errorRate: errSum / raw.length,
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Background job metrics of the replica serving the request, in Prometheus
 * text format: platform_job_runs_total{job,result},
 * platform_job_last_success_timestamp_seconds{job}, platform_api_leader.
 * Scrape every API pod and sum across them.
 */
router.get('/metrics/jobs', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), (_req: Request, res: Response) => {
  res.type('text/plain; version=0.0.4').send(renderJobMetrics());
});

export default router;
