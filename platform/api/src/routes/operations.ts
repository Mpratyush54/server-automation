import { Router, Request, Response } from 'express';
import { expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess, isGlobalProjectAdmin } from '../lib/project-access';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { getOperation, publicOperation, resolveOperationStore } from '../lib/operations';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /operations/:id — progress of a multi-step operation (deploy, secret rotation, DB provisioning).
 * Project operations need project viewer access; platform operations need admin/devops.
 * Never returns operation state (it may hold credentials) — only status, steps and summaries.
 */
router.get('/operations/:id', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Operation not found' });
    const op = await getOperation(req.params.id);
    if (!op) return res.status(404).json({ error: 'Operation not found' });
    const authReq = req as AuthenticatedRequest;
    if (op.projectId) {
      const access = await requireProjectAccess(authReq, op.projectId, ProjectAccessRole.VIEWER);
      if (access.ok === false) return res.status(access.status === 403 ? 404 : access.status).json({ error: access.status === 403 ? 'Operation not found' : access.error });
    } else if (!isGlobalProjectAdmin(authReq.user)) {
      return res.status(404).json({ error: 'Operation not found' });
    }
    return res.json(publicOperation(op));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

/** GET /operations?projectId=&type=&limit= — recent operations (newest first). */
router.get('/operations', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const type = typeof req.query.type === 'string' ? req.query.type.slice(0, 64) : undefined;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '20'), 10) || 20, 1), 100);
    if (projectId) {
      if (!UUID_RE.test(projectId)) return res.status(400).json({ error: 'projectId must be a UUID' });
      const access = await requireProjectAccess(authReq, projectId, ProjectAccessRole.VIEWER);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
    } else if (!isGlobalProjectAdmin(authReq.user)) {
      return res.status(403).json({ error: 'projectId is required' });
    }
    const store = await resolveOperationStore();
    const ops = await store.list({ projectId, type, limit });
    // Without projectId (admins only) list everything; with it, only that project's operations.
    return res.json(ops.map(publicOperation));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
