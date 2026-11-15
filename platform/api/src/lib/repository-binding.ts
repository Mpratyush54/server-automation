import { normalizeGitUrl } from './git-url';

/**
 * Repository binding for projects (#55).
 * - Each repository is linked to at most one active project. The comparison key is the
 *   normalised URL (lowercase host/owner/repo, no `.git`, no trailing slash), enforced by the
 *   `projects_repository_key_active` unique index.
 * - Source builds use a repository only after a platform administrator approved that exact
 *   binding. The approval records the key it was given for, so it lapses whenever the
 *   repository changes.
 */
export interface RepositorySource {
  repositoryUrl: string | null;
  repositoryApprovedAt?: Date | null;
  repositoryApprovedKey?: string | null;
}

export class RepositoryInUseError extends Error {
  constructor() { super('This repository is already linked to another project'); }
}

export class RepositoryNotApprovedError extends Error {
  constructor() { super('A platform administrator must approve this repository before it can be built'); }
}

export function repositoryKey(url: string | null | undefined): string | null {
  return normalizeGitUrl(url) || null;
}

export function repositoryApproved(source: RepositorySource | null | undefined): boolean {
  if (!source?.repositoryApprovedAt || !source.repositoryApprovedKey) return false;
  const key = repositoryKey(source.repositoryUrl);
  return !!key && key === source.repositoryApprovedKey;
}

export function assertRepositoryApproved(source: RepositorySource | null | undefined): void {
  if (!repositoryApproved(source)) throw new RepositoryNotApprovedError();
}

type ProjectRepositoryFields = RepositorySource & { repositoryKey?: string | null; repositoryApprovedBy?: string | null };

/** Set a project's repository; the approval is dropped when the normalised repository changes. */
export function setProjectRepository(project: ProjectRepositoryFields, url: string | null | undefined): { changed: boolean } {
  const value = typeof url === 'string' && url.trim() ? url.trim() : null;
  const key = repositoryKey(value);
  const changed = key !== repositoryKey(project.repositoryUrl);
  project.repositoryUrl = value;
  project.repositoryKey = key;
  if (changed || project.repositoryApprovedKey !== key) {
    project.repositoryApprovedBy = null;
    project.repositoryApprovedAt = null;
    project.repositoryApprovedKey = null;
  }
  return { changed };
}

/** True for the unique-index violation raised when a repository is already linked. */
export function isRepositoryConflict(error: any): boolean {
  return error?.code === '23505' && String(error?.constraint || error?.detail || '').includes('repository_key');
}
