import { projectIdMongoFilter, resolveProjectRef } from '../lib/project-resolve';
import { requireProjectAccess, listAccessibleProjectIds } from '../lib/project-access';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { connectMongo } from '../config/mongoose';
import { AuditLog } from '../entities/AuditLog';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, requireAgentScopeOrRole, AuthenticatedRequest } from '../middleware/auth';
import { LogModel } from '../schemas/Log';

const router = Router();

router.get('/audit-logs', expressAuthenticate, requireAgentScopeOrRole(['audit:read'], [UserRole.DEVOPS, UserRole.TECH_LEAD]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const logs = await ds.getRepository(AuditLog).find({
      order: { performedAt: 'DESC' },
      take: 100,
    });
    const auth = req as AuthenticatedRequest;
    const ids = await listAccessibleProjectIds(auth.user, auth.agentToken);
    return res.json(ids === null ? logs : logs.filter(log =>
      ids.includes(String(log.metadata?.projectId || '')) ||
      (log.targetType === 'Project' && ids.includes(String(log.targetId))),
    ));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.get('/logs/search', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (authReq.agentToken) {
      const scopes = authReq.agentToken.scopes || [];
      if (!scopes.includes('*') && !scopes.includes('logs:read')) {
        return res.status(403).json({ error: 'Forbidden: Agent token missing logs:read scope' });
      }
    }
    const [projectId, environmentId, serviceName, level, search, limit, offset] =
      ['projectId', 'environmentId', 'serviceName', 'level', 'search', 'limit', 'offset'].map(key => req.query[key] == null ? '' : String(req.query[key]));
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

    if (environmentId) filter.environment = environmentId;
    if (serviceName) filter.serviceName = serviceName;
    if (level) filter.level = level;
    if (search) filter.message = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const maxLimit = Math.min(500, Math.max(1, parseInt(limit || '50', 10) || 50));
    const skipOffset = Math.max(0, parseInt(offset || '0', 10) || 0);

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
