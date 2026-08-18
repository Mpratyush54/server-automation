import { getDb } from '../config/database';
import { Notification } from '../entities/Notification';
import { User, UserRole } from '../entities/User';

export async function notifyUser(params: {
  userId: string;
  title: string;
  body?: string;
  kind?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const ds = await getDb();
    const repo = ds.getRepository(Notification);
    await repo.save(repo.create({
      userId: params.userId,
      title: params.title,
      body: params.body || null,
      kind: params.kind || 'info',
      link: params.link || null,
      metadata: params.metadata || null,
      readAt: null,
    }));
  } catch {}
}

export async function notifyRoles(params: {
  roles: UserRole[];
  title: string;
  body?: string;
  kind?: string;
  link?: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find();
    const targets = users.filter((u) => params.roles.includes(u.role) || u.role === UserRole.ADMIN);
    await Promise.all(targets.map((u) => notifyUser({ ...params, userId: u.id })));
  } catch {}
}
