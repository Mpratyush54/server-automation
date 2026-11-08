import { userCanAccessProject } from '../lib/project-access';
import { Router, Request, Response } from 'express';
import { getDb } from '../config/database';
import { Notification } from '../entities/Notification';
import { expressAuthenticate, AuthenticatedRequest, logAudit } from '../middleware/auth';

const router = Router();

router.get('/notifications', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user!.id;
    const unread = String(req.query.unread || '') === 'true';
    const ds = await getDb();
    const repo = ds.getRepository(Notification);
    const where: any = { userId };
    const items = await repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: 50,
    });
    const visible = [];
    for (const item of items) {
      if (!item.metadata?.projectId || await userCanAccessProject(String(item.metadata.projectId), (req as AuthenticatedRequest).user)) visible.push(item);
    }
    const filtered = unread ? visible.filter((n) => !n.readAt) : visible;
    const unreadCount = visible.filter((n) => !n.readAt).length;
    return res.json({ items: filtered, unreadCount });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to list notifications' });
  }
});

router.post('/notifications/read-all', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user!.id;
    const ds = await getDb();
    const repo = ds.getRepository(Notification);
    const unread = await repo.find({ where: { userId } });
    const now = new Date();
    for (const n of unread) {
      if (!n.readAt && (!n.metadata?.projectId || await userCanAccessProject(String(n.metadata.projectId), (req as AuthenticatedRequest).user))) {
        n.readAt = now;
        await repo.save(n);
      }
    }
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/:id/read', expressAuthenticate, async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).user!.id;
    const ds = await getDb();
    const repo = ds.getRepository(Notification);
    const n = await repo.findOne({ where: { id: req.params.id, userId } });
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    if (n.metadata?.projectId && !await userCanAccessProject(String(n.metadata.projectId), (req as AuthenticatedRequest).user)) return res.status(403).json({ error: 'Forbidden: no access to this project' });
    n.readAt = new Date();
    await repo.save(n);
    await logAudit({ userId, action: 'notification.read', targetType: 'notification', targetId: n.id, ip: req.ip });
    return res.json(n);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
