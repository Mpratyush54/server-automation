import { getDb } from '../config/database';
import { ProjectMember, ProjectAccessRole, PROJECT_ROLE_RANK } from '../entities/ProjectMember';
import { UserRole } from '../entities/User';
import { AuthenticatedRequest } from '../middleware/auth';

/** Platform admins / global devops bypass project membership. */
export function isGlobalProjectAdmin(user?: { role?: string } | null): boolean {
  const role = user?.role;
  return role === UserRole.ADMIN || role === UserRole.DEVOPS;
}

export async function getProjectMembership(
  projectId: string,
  userId: string,
): Promise<ProjectMember | null> {
  const ds = await getDb();
  return ds.getRepository(ProjectMember).findOne({ where: { projectId, userId } });
}

export async function userCanAccessProject(
  projectId: string,
  user: { id: string; role: string } | undefined,
  minRole: ProjectAccessRole = ProjectAccessRole.VIEWER,
): Promise<boolean> {
  if (!user) return false;
  if (isGlobalProjectAdmin(user)) return true;
  const membership = await getProjectMembership(projectId, user.id);
  if (!membership) return false;
  return PROJECT_ROLE_RANK[membership.role] >= PROJECT_ROLE_RANK[minRole];
}

export async function requireProjectAccess(
  req: AuthenticatedRequest,
  projectId: string,
  minRole: ProjectAccessRole = ProjectAccessRole.VIEWER,
): Promise<{ ok: true; membership: ProjectMember | null } | { ok: false; status: number; error: string }> {
  const user = req.user;
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
  if (isGlobalProjectAdmin(user)) return { ok: true, membership: null };
  const membership = await getProjectMembership(projectId, user.id);
  if (!membership) {
    return { ok: false, status: 403, error: 'Forbidden: no access to this project' };
  }
  if (PROJECT_ROLE_RANK[membership.role] < PROJECT_ROLE_RANK[minRole]) {
    return { ok: false, status: 403, error: `Forbidden: requires project role ${minRole} or higher` };
  }
  return { ok: true, membership };
}

export async function listAccessibleProjectIds(user: { id: string; role: string }): Promise<string[] | null> {
  // null = all projects
  if (isGlobalProjectAdmin(user)) return null;
  const ds = await getDb();
  const rows = await ds.getRepository(ProjectMember).find({ where: { userId: user.id } });
  return rows.map((r) => r.projectId);
}

export async function ensureProjectOwner(projectId: string, userId: string): Promise<void> {
  const ds = await getDb();
  const repo = ds.getRepository(ProjectMember);
  const existing = await repo.findOne({ where: { projectId, userId } });
  if (existing) {
    if (existing.role !== ProjectAccessRole.OWNER) {
      existing.role = ProjectAccessRole.OWNER;
      await repo.save(existing);
    }
    return;
  }
  await repo.save(repo.create({
    projectId,
    userId,
    role: ProjectAccessRole.OWNER,
    grantedById: userId,
  }));
}
