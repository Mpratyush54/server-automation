import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { AuditLog } from '../entities/AuditLog';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';
import { LogModel } from '../schemas/Log';

const router = Router();

router.get('/audit-logs', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const logs = await ds.getRepository(AuditLog).find({
      order: { performedAt: 'DESC' },
      take: 100,
    });
    return res.json(logs);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/logs/search', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, environmentId, serviceName, level, search, limit, offset } = req.query as Record<string, string>;
    await connectMongo();
    const filter: Record<string, any> = {};
    if (projectId) filter.projectId = projectId;
    if (environmentId) filter.environment = environmentId;
    if (serviceName) filter.serviceName = serviceName;
    if (level) filter.level = level;
    if (search) filter.message = { $regex: search, $options: 'i' };

    const maxLimit = parseInt(limit || '50', 10);
    const skipOffset = parseInt(offset || '0', 10);

    const [logs, total] = await Promise.all([
      LogModel.find(filter).sort({ timestamp: -1 }).skip(skipOffset).limit(maxLimit).lean(),
      LogModel.countDocuments(filter),
    ]);

    return res.json({ logs, total });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
