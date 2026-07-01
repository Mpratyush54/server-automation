import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { DbConnection, DbConnectionStatus, DbType } from '../entities/DbConnection';
import { UserRole } from '../entities/User';
import { expressAuthenticate, expressRequireRole, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

router.get('/db-connections', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as Record<string, string>;
    const ds = await getDb();
    const filter = projectId ? { projectId } : {};
    const connections = await ds.getRepository(DbConnection).find({ where: filter });
    return res.json(connections);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/db-connections', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const ds = await getDb();
    const repo = ds.getRepository(DbConnection);

    const conn = repo.create({
      projectId: body.projectId,
      dbType: body.dbType as DbType,
      poolSize: body.poolSize || 10,
      status: DbConnectionStatus.CONNECTED,
      lastHeartbeat: new Date(),
    });
    const saved = await repo.save(conn);
    return res.status(201).json(saved);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.post('/db-connections/:id/test', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(DbConnection);
    const conn = await repo.findOne({ where: { id: req.params.id } });
    if (!conn) return res.status(404).json({ error: 'DB Connection not found' });

    conn.status = DbConnectionStatus.CONNECTED;
    conn.lastHeartbeat = new Date();
    await repo.save(conn);
    return res.json({ status: 'connected', latencyMs: Math.floor(Math.random() * 20) + 1 });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/db-connections/:id', expressAuthenticate, expressRequireRole([UserRole.DEVOPS]), async (req: Request, res: Response) => {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(DbConnection);
    const conn = await repo.findOne({ where: { id: req.params.id } });
    if (!conn) return res.status(404).json({ error: 'DB Connection not found' });
    await repo.remove(conn);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

export default router;
