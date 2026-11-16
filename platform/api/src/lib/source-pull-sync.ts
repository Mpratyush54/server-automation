import { In, Not, IsNull } from 'typeorm';
import { getDb } from '../config/database';
import { Environment } from '../entities/Environment';
import { Project } from '../entities/Project';
import { registrySignerKid } from './registry-token';
import { applySourcePullSecret } from './source-deploy';

let syncedKid: string | null = null;

/**
 * Per-project pull credentials are derived from the registry signing key, so rotating the key
 * invalidates every namespace's `source-registry` Secret. Run periodically on the leader: when the
 * key differs from the one last written (and once after start), rewrite the Secret of every
 * active environment that runs a source-built image. Failures are retried on the next run.
 */
export async function syncSourcePullSecrets(): Promise<{ written: number; failed: number }> {
  const kid = await registrySignerKid();
  if (kid === syncedKid) return { written: 0, failed: 0 };
  const ds = await getDb();
  const envs = await ds.getRepository(Environment).find({ where: { isActive: true, sourceImage: Not(IsNull()) } });
  const projectIds = [...new Set(envs.map(e => e.projectId))];
  const active = new Set((projectIds.length ? await ds.getRepository(Project).find({ where: { id: In(projectIds), isActive: true } }) : []).map(p => p.id));
  let written = 0; let failed = 0;
  for (const env of envs.filter(e => active.has(e.projectId))) {
    try { await applySourcePullSecret(env.namespace, env.projectId); written++; }
    catch { failed++; }
  }
  if (!failed) syncedKid = kid;
  return { written, failed };
}

/** Test hook. */
export function resetSourcePullSyncForTests(): void { syncedKid = null; }
