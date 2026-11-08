import { ProjectAccessRole } from '../entities/ProjectMember';
import { getDb } from '../config/database';
import { projectIdMongoFilter, resolveProjectRef } from '../lib/project-resolve';
import { requireProjectAccess, listAccessibleProjectIds } from '../lib/project-access';
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
    const report = await BugReportModel.findById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Bug report not found' });
    const ds = await getDb();
    const ref = await resolveProjectRef(ds, String(report.projectId));
    if (!ref) return res.status(404).json({ error: 'Project not found' });
    const access = await requireProjectAccess(req as AuthenticatedRequest, ref.id, ProjectAccessRole.DEVOPS);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    await BugReportModel.findByIdAndDelete(req.params.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
