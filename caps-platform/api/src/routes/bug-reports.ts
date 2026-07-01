import { Router, Request, Response } from 'express';
import { connectMongo } from '../config/mongoose';
import { BugReportModel } from '../schemas/BugReport';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/bug-reports', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, limit, offset } = req.query as Record<string, string>;
    await connectMongo();
    const filter: any = {};
    if (projectId) filter.projectId = projectId;
    const [reports, total] = await Promise.all([
      BugReportModel.find(filter).sort({ timestamp: -1 }).skip(parseInt(offset || '0', 10)).limit(parseInt(limit || '20', 10)).lean(),
      BugReportModel.countDocuments(filter),
    ]);
    return res.json({ reports, total });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/bug-reports/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    await connectMongo();
    await BugReportModel.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
