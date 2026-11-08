import { acquireLockOrThrow, projectLockKey } from './locks';
import { defineOperation, executeOperation, newOperationId } from './operations';
import {
  applyPostgresRoleAndDatabase,
  dropPostgresRoleAndDatabase,
  persistPostgresCreds,
  PostgresIdentity,
  resolvePostgresIdentity,
} from './project-db-ensure';

export const DB_PROVISION_OPERATION = 'project.db-provision';

type ProvisionState = {
  environment: string;
  /** Contains the role password → the operation is `sensitive` (encrypted at rest, wiped when done). */
  identity?: PostgresIdentity;
  createdRole?: boolean;
  createdDatabase?: boolean;
};

/**
 * Per-project Postgres provisioning as explicit steps:
 *  1. resolve-identity          id-based db/role names + password (reused on resume)
 *  2. apply-role-and-database   CREATE/ALTER ROLE, CREATE DATABASE, GRANT
 *                               compensate: drop the role/database only if this operation created them
 *  3. store-credentials         encrypted project secrets for SDK getDbCredentials
 * A failure in step 3 compensates step 2, so a half-provisioned database is not left behind.
 */
export const dbProvisionOperation = defineOperation<ProvisionState>({
  type: DB_PROVISION_OPERATION,
  sensitive: true,
  resume: 'continue',
  summarize: (s) => ({
    environment: s.environment,
    dbName: s.identity?.dbName ?? null,
    username: s.identity?.username ?? null,
  }),
  steps: [
    {
      name: 'resolve-identity',
      async run(ctx) {
        if (!ctx.projectId) throw new Error('projectId is required');
        if (!ctx.state.identity) {
          ctx.state.identity = await resolvePostgresIdentity(ctx.projectId, ctx.state.environment);
        }
        ctx.setOutput({ dbName: ctx.state.identity.dbName, username: ctx.state.identity.username });
      },
    },
    {
      name: 'apply-role-and-database',
      async run(ctx) {
        const created = await applyPostgresRoleAndDatabase(ctx.state.identity!);
        // On a re-run after a crash, keep what the first attempt created.
        ctx.state.createdRole = !!ctx.state.createdRole || created.createdRole;
        ctx.state.createdDatabase = !!ctx.state.createdDatabase || created.createdDatabase;
        ctx.setOutput({ createdRole: ctx.state.createdRole, createdDatabase: ctx.state.createdDatabase });
      },
      async compensate(ctx) {
        if (!ctx.state.identity) return;
        await dropPostgresRoleAndDatabase(ctx.state.identity, {
          createdRole: ctx.state.createdRole,
          createdDatabase: ctx.state.createdDatabase,
        });
      },
    },
    {
      name: 'store-credentials',
      async run(ctx) {
        await persistPostgresCreds(ctx.projectId!, ctx.state.environment, ctx.state.identity!);
      },
    },
  ],
});

export interface ProvisionOutcome {
  operationId: string;
  status: string;
  creds?: PostgresIdentity;
  error?: string;
}

/**
 * Provision under `lock:project:<id>:db-provision:<env>` (LockBusyError → 409 at the route).
 */
export async function provisionProjectPostgres(opts: {
  projectId: string;
  environment: string;
  actorUserId?: string | null;
}): Promise<ProvisionOutcome> {
  const id = newOperationId();
  const lockKey = projectLockKey(opts.projectId, 'db-provision', encodeURIComponent(opts.environment).slice(0, 96));
  const lock = await acquireLockOrThrow(lockKey, { holder: id });
  const run = await executeOperation<ProvisionState>(DB_PROVISION_OPERATION, {
    id,
    projectId: opts.projectId,
    lockKey,
    input: { environment: opts.environment },
    state: { environment: opts.environment },
    createdById: opts.actorUserId ?? null,
    lock,
  });
  const state = run.state as ProvisionState;
  if (run.operation.status === 'succeeded' && state.identity) {
    return { operationId: run.operation.id, status: run.operation.status, creds: state.identity };
  }
  return { operationId: run.operation.id, status: run.operation.status, error: run.operation.error || 'Provisioning failed' };
}
