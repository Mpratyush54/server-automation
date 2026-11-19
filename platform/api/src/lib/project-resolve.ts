import { DataSource, IsNull, Not } from 'typeorm';
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
  // Names are unique only among projects that are not deleted: resolve to that one.
  const byName = await repo.findOne({ where: { name: projectIdOrName, deletedAt: IsNull() } });
  if (byName) return { id: byName.id, name: byName.name };
  return null;
}

/**
 * True when no other project row (deleted ones included) ever used this project's name, so
 * name-keyed legacy data can only belong to this project.
 */
async function nameIsUnambiguous(ds: DataSource, ref: { id: string; name: string }): Promise<boolean> {
  const other = await ds.getRepository(Project).findOne({ where: { name: ref.name, id: Not(ref.id) } });
  return !other;
}

/** Mongo filter that matches both UUID and project-name projectId values (legacy SDK data). */
export async function projectIdMongoFilter(
  ds: DataSource,
  projectIdOrName: string
): Promise<Record<string, any>> {
  const ref = await resolveProjectRef(ds, projectIdOrName);
  if (!ref) return { projectId: projectIdOrName };
  // Legacy SDK data is keyed by project name. Once a name was reused after a delete, that data
  // cannot be told apart, so a reused name never matches it (only the id does).
  const aliases = (await nameIsUnambiguous(ds, ref)) ? [ref.name, projectIdOrName] : [];
  const ids = Array.from(new Set([ref.id, ...aliases].filter(Boolean)));
  return ids.length === 1 ? { projectId: ids[0] } : { projectId: { $in: ids } };
}
