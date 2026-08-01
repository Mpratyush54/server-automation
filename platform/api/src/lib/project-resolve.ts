import { DataSource } from 'typeorm';
import { Project } from '../entities/Project';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a project UUID or name → { id, name }. */
export async function resolveProjectRef(
  ds: DataSource,
  projectIdOrName?: string | null
): Promise<{ id: string; name: string } | null> {
  if (!projectIdOrName) return null;
  const repo = ds.getRepository(Project);
  if (UUID_RE.test(projectIdOrName)) {
    const byId = await repo.findOne({ where: { id: projectIdOrName } });
    if (byId) return { id: byId.id, name: byId.name };
  }
  const byName = await repo.findOne({ where: { name: projectIdOrName } });
  if (byName) return { id: byName.id, name: byName.name };
  return null;
}

/** Mongo filter that matches both UUID and project-name projectId values (legacy SDK data). */
export async function projectIdMongoFilter(
  ds: DataSource,
  projectIdOrName: string
): Promise<Record<string, any>> {
  const ref = await resolveProjectRef(ds, projectIdOrName);
  if (!ref) return { projectId: projectIdOrName };
  const ids = Array.from(new Set([ref.id, ref.name, projectIdOrName].filter(Boolean)));
  return ids.length === 1 ? { projectId: ids[0] } : { projectId: { $in: ids } };
}
