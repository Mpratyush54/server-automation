import { Router } from 'express';
import { expressAuthenticate, AuthenticatedRequest } from '../middleware/auth';
import { requireProjectAccess } from '../lib/project-access';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { databaseInsights, monitoringEnabled } from '../lib/database-insights';

const router = Router();
router.get('/projects/:projectId/databases/insights', expressAuthenticate, async (req, res) => {
  try {
    const access = await requireProjectAccess(req as AuthenticatedRequest, req.params.projectId);
    if (access.ok === false) return res.status(access.status).json({ error: access.error });
    const project = await (await getDb()).getRepository(Project).findOne({ where: { id: req.params.projectId }, relations: ['environments'] });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const environment = typeof req.query.environment === 'string' ? req.query.environment : 'production';
    if (!project.environments.some(e => e.name === environment)) return res.status(400).json({ error: 'Unknown environment' });
    if (!monitoringEnabled()) return res.json({ enabled: false, reason: 'Database monitoring requires the full observability profile' });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(await databaseInsights(project, environment));
  } catch { return res.status(503).json({ error: 'Database insights unavailable' }); }
});
export default router;
