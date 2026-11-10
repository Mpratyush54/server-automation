import { Project } from '../entities/Project';
import { getDb } from '../config/database';
import { resolveDefaultBranch } from './git-remote';

export function explicitRevision(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x20\x7f]/.test(value)) {
    throw new Error('Git revision must be a non-empty ref of at most 200 characters without whitespace');
  }
  return value;
}

/** Persist discovery per project, shared across replicas. Explicit deploy refs never poison the cache. */
export async function projectRevision(project: Project, gitRevision?: unknown, branch?: unknown): Promise<string> {
  const explicit = explicitRevision(gitRevision) || explicitRevision(branch) || explicitRevision(project.gitRevision);
  if (explicit) return explicit;
  if (project.defaultBranch) return project.defaultBranch;
  const resolved = project.repositoryUrl ? await resolveDefaultBranch(project.repositoryUrl) : 'HEAD';
  if (resolved !== 'HEAD') {
    const ds = await getDb();
    // A concurrent repository/settings update must not receive an old repository's discovery.
    await ds.getRepository(Project).update({ id: project.id, repositoryUrl: project.repositoryUrl! }, { defaultBranch: resolved });
    project.defaultBranch = resolved;
  }
  return resolved;
}
