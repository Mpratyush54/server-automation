import { createHash } from 'crypto';

/** Stable database/ACL identity; never derived from an editable project name. */
export function projectDbIdentity(projectId: string, environment: string): { id: string; env: string } {
  return {
    id: createHash('sha256').update(projectId).digest('hex').slice(0, 20),
    env: createHash('sha256').update(environment).digest('hex').slice(0, 12),
  };
}
