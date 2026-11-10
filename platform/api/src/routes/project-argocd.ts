import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { ProjectAccessRole } from '../entities/ProjectMember';
import { requireProjectAccess } from '../lib/project-access';
import { argoAppName } from '../lib/k8s';
import { actOnArgoApp, argoClient } from '../lib/argocd';
import { AuthenticatedRequest, expressAuthenticate, logAudit } from '../middleware/auth';

const router = Router();
for (const action of ['refresh', 'sync'] as const) {
  router.post(`/projects/:projectId/argocd/${action}`, expressAuthenticate, async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const access = await requireProjectAccess(authReq, req.params.projectId, ProjectAccessRole.DEVELOPER);
      if (access.ok === false) return res.status(access.status).json({ error: access.error });
      const ds = await getDb();
      const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId }, relations: ['environments'] });
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const environment = String(req.body?.env || 'development');
      const env = project.environments?.find(e => String(e.name) === environment);
      if (!env) return res.status(404).json({ error: 'Environment not found' });
      const appName = env.namespace || argoAppName(project.name, environment, project.id);
      await actOnArgoApp(argoClient(), appName, action, authReq.user!.id);
      await logAudit({
        userId: authReq.user!.id, action: `argocd.${action}`, targetType: 'Project', targetId: project.id,
        metadata: { appName, environment }, ip: req.ip,
      });
      return res.status(202).json({ accepted: true, appName, action });
    } catch (err: any) {
      const status = err.statusCode || err.code || err.response?.statusCode;
      return res.status(status === 404 ? 404 : status === 409 || status === 422 ? 409 : 502).json({ error: err.message });
    }
  });
}
export default router;
