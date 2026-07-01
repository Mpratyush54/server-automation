import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, logAudit, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.post('/projects/:projectId/databases/provision', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const { environment } = req.body;
    if (!environment) return res.status(400).json({ error: 'environment is required' });
    const ds = await getDb();
    const project = await ds.getRepository(Project).findOne({ where: { id: req.params.projectId } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { provisionPostgresDb } = await import('../lib/database-service');
    const creds = await provisionPostgresDb(project.name, environment);

    await logAudit({
      userId: (req as AuthenticatedRequest).user?.id,
      action: 'database.provisioned',
      targetType: 'Project',
      targetId: project.id,
      metadata: { dbName: creds.dbName, environment },
      ip: req.ip,
    });

    return res.status(201).json({
      dbName: creds.dbName,
      username: creds.username,
      password: creds.password,
      host: creds.host,
      port: creds.port,
      connectionString: `postgresql://${creds.username}:${creds.password}@${creds.host}:${creds.port}/${creds.dbName}`,
      message: 'Database provisioned. Save these credentials — the password will not be shown again.',
    });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
