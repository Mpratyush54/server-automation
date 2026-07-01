import { Router, Request, Response } from 'express';
import { connectMongo } from '../config/mongoose';
import { MetricsRawModel } from '../schemas/MetricsRaw';
import { expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/metrics', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    await connectMongo();
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;

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
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;

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

export default router;
