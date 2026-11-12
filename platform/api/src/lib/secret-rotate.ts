import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import Redis from 'ioredis';
import { getDb, reconnectPostgres } from '../config/database';
import { User, UserRole } from '../entities/User';
import { patchSecretData, restartNamedDeployment } from './k8s';
import {
  canConnectPostgres,
  clearRotatePending,
  recoverPostgresAuth,
  recoverRedisAuth,
  writeRotatePending,
} from './credential-recover';
import { persistPlatformEnv } from './host-env';
import { PLATFORM_CREDENTIALS_SECRET } from './config-store';
import { acquireLockOrThrow, LockHandle, platformLockKey } from './locks';
import { defineOperation, executeOperation, newOperationId, StepContext } from './operations';

function randomSecret(bytes = 18): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export type RotateResult = {
  key: string;
  ok: boolean;
  detail: string;
};

async function tryPatchSecret(namespace: string, name: string, data: Record<string, string>): Promise<RotateResult> {
  try {
    await patchSecretData(namespace, name, data);
    return { key: `${namespace}/${name}`, ok: true, detail: 'secret updated' };
  } catch (err: any) {
    return { key: `${namespace}/${name}`, ok: false, detail: err?.message || 'secret patch failed' };
  }
}

function postgresUser(): string {
  return process.env.POSTGRES_USER || 'postgres';
}

async function alterPostgresPassword(newPassword: string, currentPassword?: string): Promise<RotateResult> {
  const host = process.env.POSTGRES_HOST || 'postgresql.databases.svc.cluster.local';
  const port = parseInt(process.env.POSTGRES_PORT || '5432', 10);
  const user = postgresUser();
  const current = currentPassword ?? (process.env.POSTGRES_PASSWORD || '');
  const database = process.env.POSTGRES_DB || 'platform';
  const client = new Client({
    host,
    port,
    user,
    password: current,
    database,
    connectionTimeoutMillis: 8000,
  });
  try {
    await client.connect();
    const ident = user.replace(/"/g, '');
    const escaped = newPassword.replace(/'/g, "''");
    await client.query(`ALTER USER "${ident}" WITH PASSWORD '${escaped}'`);
    return { key: 'POSTGRES_PASSWORD', ok: true, detail: `ALTER USER ${ident}` };
  } catch (err: any) {
    return { key: 'POSTGRES_PASSWORD', ok: false, detail: err?.message || 'postgres ALTER USER failed' };
  } finally {
    await client.end().catch(() => {});
  }
}

async function alterRedisPassword(newPassword: string, currentPassword?: string): Promise<RotateResult> {
  const { redisEndpointOptions, redisSentinelConfig } = await import('./redis-endpoint');
  // Sentinel HA: password must change on every data node and every Sentinel together via platformctl.
  if (redisSentinelConfig()) {
    return {
      key: 'REDIS_PASSWORD',
      ok: false,
      detail: 'skipped: Redis runs with Sentinel (ha profile); rotate the Redis password with platformctl recover/provision so every node and sentinel changes together',
    };
  }
  const current = currentPassword ?? (process.env.REDIS_PASSWORD || '');
  const client = new Redis({
    ...redisEndpointOptions({ defaultHost: 'redis-master.databases.svc.cluster.local' }),
    password: current || undefined,
    connectTimeout: 5000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    await client.config('SET', 'requirepass', newPassword);
    await client.auth(newPassword);
    return { key: 'REDIS_PASSWORD', ok: true, detail: 'CONFIG SET requirepass' };
  } catch (err: any) {
    return { key: 'REDIS_PASSWORD', ok: false, detail: err?.message || 'redis CONFIG SET failed' };
  } finally {
    client.disconnect();
  }
}

async function rotateAdminPassword(admin: string): Promise<RotateResult> {
  try {
    const ds = await getDb();
    const users = await ds.getRepository(User).find({ where: { role: UserRole.ADMIN } });
    const hash = await bcrypt.hash(admin, 10);
    for (const u of users) {
      u.passwordHash = hash;
      await ds.getRepository(User).save(u);
    }
    return { key: 'ADMIN_PASSWORD', ok: true, detail: `updated ${users.length} admin user(s)` };
  } catch (err: any) {
    return { key: 'ADMIN_PASSWORD', ok: false, detail: err?.message || 'admin password update failed' };
  }
}

async function healPostgres(results: RotateResult[]): Promise<void> {
  try {
    const recovered = await recoverPostgresAuth();
    results.push({
      key: 'POSTGRES_RECOVER',
      ok: recovered.ok,
      detail: recovered.detail,
    });
  } catch (err: any) {
    results.push({
      key: 'POSTGRES_RECOVER',
      ok: false,
      detail: err?.message || 'postgres self-recovery failed',
    });
  }
}

async function healRedis(results: RotateResult[]): Promise<void> {
  try {
    const recovered = await recoverRedisAuth();
    results.push({
      key: 'REDIS_RECOVER',
      ok: recovered.ok,
      detail: recovered.detail,
    });
  } catch (err: any) {
    results.push({
      key: 'REDIS_RECOVER',
      ok: false,
      detail: err?.message || 'redis self-recovery failed',
    });
  }
}


/** True when Redis accepts `password` (used only when resuming an interrupted rotation). */
async function redisAcceptsPassword(password: string): Promise<boolean> {
  const { redisEndpointOptions } = await import('./redis-endpoint');
  const client = new Redis({
    ...redisEndpointOptions({ defaultHost: 'redis-master.databases.svc.cluster.local' }),
    password: password || undefined,
    connectTimeout: 5000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

export const SECRET_ROTATION_OPERATION = 'platform.secret-rotation';
export const SECRET_ROTATION_LOCK_KEY = platformLockKey('secret-rotation');

/**
 * Working state of a rotation. Contains the generated credentials, so the operation is
 * `sensitive`: it is stored AES-GCM encrypted in operations.state_encrypted while the
 * rotation runs (needed to resume after a crash) and wiped once it is terminal.
 */
type RotationState = {
  actorUserId: string;
  admin: string;
  webhook: string;
  postgres: string;
  redisPassword: string;
  argocd: string;
  previousPostgres: string;
  previousRedis: string;
  adminOk: boolean;
  redisOk: boolean;
  pgOk: boolean;
  results: RotateResult[];
  values: Record<string, string>;
};

const stepResults = new WeakMap<object, RotateResult[]>();

/** Record results in the overall list and in this step's (non-secret) log output. */
function push(ctx: StepContext<RotationState>, ...items: RotateResult[]) {
  ctx.state.results.push(...items);
  const mine = stepResults.get(ctx) || [];
  mine.push(...items);
  stepResults.set(ctx, mine);
  ctx.setOutput({ results: mine.map((r) => ({ key: r.key, ok: r.ok, detail: r.detail })) });
}

/**
 * Steps (all idempotent, so the leader can re-run the one that was in flight after a crash):
 *  1. admin-password      bcrypt the new admin password into every admin user
 *  2. write-ahead         previous+next passwords to platform-credentials (ConfigStore) and
 *                         platform-rotate-pending;
 *                         refuses to continue (fails the operation) when neither is durable
 *  3. redis-password      CONFIG SET requirepass (on resume: skipped if the new one already works)
 *  4. postgres-password   ALTER USER + TypeORM reconnect (on resume: same check)
 *  5. patch-secrets       platform-env (webhook secret only), databases/postgresql, databases/redis
 *  6. argocd-password     argocd-secret + argocd-initial-admin-secret
 *  7. finalize            clear platform-rotate-pending when both datastores rotated; notify (outbox)
 *  8. restart-api         rollout restart of platform-api (never repeated after a crash)
 * Credential convergence after a crash does not depend on this log alone: the API boot path
 * (credential-recover) still syncs secrets to whichever stored password authenticates.
 */
export const secretRotationOperation = defineOperation<RotationState>({
  type: SECRET_ROTATION_OPERATION,
  sensitive: true,
  resume: 'continue',
  summarize: (s) => ({
    results: (s.results || []).map((r) => ({ key: r.key, ok: r.ok, detail: r.detail })),
    rotated: Object.keys(s.values || {}),
  }),
  async onFailed(ctx, error) {
    ctx.emit('notify.roles', {
      roles: [UserRole.ADMIN, UserRole.DEVOPS],
      title: 'Platform secret rotation failed',
      body: `Rotation stopped: ${error.slice(0, 300)}. Datastore passwords that were not changed keep working.`,
      kind: 'security',
      link: '/settings',
      metadata: { actorUserId: ctx.state.actorUserId, operationId: ctx.operationId },
    });
  },
  steps: [
    {
      name: 'admin-password',
      async run(ctx) {
        const s = ctx.state;
        const adminResult = await rotateAdminPassword(s.admin);
        push(ctx, adminResult);
        s.adminOk = adminResult.ok;
        if (adminResult.ok) {
          s.values.ADMIN_PASSWORD = s.admin;
          process.env.ADMIN_PASSWORD = s.admin;
        }
      },
    },
    {
      name: 'write-ahead',
      async run(ctx) {
        const s = ctx.state;
        const hostAhead = await persistPlatformEnv({
          ADMIN_PASSWORD: s.adminOk ? s.admin : '',
          POSTGRES_PASSWORD_PREV: s.previousPostgres,
          POSTGRES_PASSWORD_NEXT: s.postgres,
          REDIS_PASSWORD_PREV: s.previousRedis,
          REDIS_PASSWORD_NEXT: s.redisPassword,
        });
        push(ctx, {
          key: `credentials:${PLATFORM_CREDENTIALS_SECRET}`,
          ok: hostAhead.ok,
          detail: hostAhead.ok
            ? `wrote previous/next passwords before rotating (${hostAhead.detail})`
            : `could not write the credentials store (${hostAhead.detail}); Kubernetes pending secret is required before ALTER`,
        });

        s.values.PLATFORM_WEBHOOK_SECRET = s.webhook;
        process.env.PLATFORM_WEBHOOK_SECRET = s.webhook;

        let pendingOk = false;
        try {
          await writeRotatePending({
            POSTGRES_PASSWORD_OLD: s.previousPostgres,
            POSTGRES_PASSWORD_NEW: s.postgres,
            REDIS_PASSWORD_OLD: s.previousRedis,
            REDIS_PASSWORD_NEW: s.redisPassword,
          });
          pendingOk = true;
          push(ctx, { key: 'platform/platform-rotate-pending', ok: true, detail: 'wrote old+new passwords for self-recovery' });
        } catch (err: any) {
          push(ctx, {
            key: 'platform/platform-rotate-pending',
            ok: false,
            detail: err?.message || 'could not write rotate-pending secret',
          });
        }

        if (!hostAhead.ok && !pendingOk) {
          push(
            ctx,
            {
              key: 'POSTGRES_PASSWORD',
              ok: false,
              detail: 'refused ALTER USER: neither platform-credentials nor platform-rotate-pending could be written',
            },
            {
              key: 'REDIS_PASSWORD',
              ok: false,
              detail: 'refused CONFIG SET: no durable password copy in Kubernetes',
            },
          );
          throw new Error('no durable copy of the new passwords; datastore passwords left unchanged');
        }
      },
    },
    {
      name: 'redis-password',
      async run(ctx) {
        const s = ctx.state;
        const retry = ctx.resumed || ctx.attempt > 1;
        let redisResult: RotateResult;
        if (retry && (await redisAcceptsPassword(s.redisPassword))) {
          redisResult = { key: 'REDIS_PASSWORD', ok: true, detail: 'already rotated before the interruption' };
        } else {
          redisResult = await alterRedisPassword(s.redisPassword, retry ? s.previousRedis : undefined);
        }
        push(ctx, redisResult);
        s.redisOk = redisResult.ok;
        if (redisResult.ok) {
          s.values.REDIS_PASSWORD = s.redisPassword;
          process.env.REDIS_PASSWORD = s.redisPassword;
          const saved = await persistPlatformEnv({ REDIS_PASSWORD: s.redisPassword });
          push(ctx, { key: `${PLATFORM_CREDENTIALS_SECRET}:REDIS_PASSWORD`, ok: saved.ok, detail: saved.detail });
        } else {
          await healRedis(s.results);
        }
      },
    },
    {
      name: 'postgres-password',
      async run(ctx) {
        const s = ctx.state;
        const retry = ctx.resumed || ctx.attempt > 1;
        let pgAlter: RotateResult;
        if (retry && (await canConnectPostgres(s.postgres))) {
          pgAlter = { key: 'POSTGRES_PASSWORD', ok: true, detail: 'already rotated before the interruption' };
        } else {
          pgAlter = await alterPostgresPassword(s.postgres, retry ? s.previousPostgres : undefined);
        }
        push(ctx, pgAlter);
        s.pgOk = pgAlter.ok;
        if (pgAlter.ok) {
          s.values.POSTGRES_PASSWORD = s.postgres;
          process.env.POSTGRES_PASSWORD = s.postgres;
          const saved = await persistPlatformEnv({ POSTGRES_PASSWORD: s.postgres, ADMIN_PASSWORD: s.adminOk ? s.admin : '' });
          push(ctx, { key: `${PLATFORM_CREDENTIALS_SECRET}:POSTGRES_PASSWORD`, ok: saved.ok, detail: saved.detail });
          try {
            await reconnectPostgres(s.postgres);
          } catch (err: any) {
            push(ctx, {
              key: 'POSTGRES_RECONNECT',
              ok: false,
              detail: err?.message || 'TypeORM reconnect after ALTER failed',
            });
            await healPostgres(s.results);
          }
        } else {
          await healPostgres(s.results);
        }
      },
    },
    {
      name: 'patch-secrets',
      async run(ctx) {
        const s = ctx.state;
        // Credentials live in platform-credentials (written by the earlier steps via
        // persistPlatformEnv); platform-env keeps only non-credential config.
        push(ctx, await tryPatchSecret('platform', 'platform-env', { PLATFORM_WEBHOOK_SECRET: s.webhook }));

        if (s.pgOk) {
          push(ctx, await tryPatchSecret('databases', 'postgresql', {
            'postgres-password': s.postgres,
            password: s.postgres,
          }));
        } else {
          push(ctx, { key: 'databases/postgresql', ok: false, detail: 'skipped: postgres ALTER USER did not succeed' });
        }

        if (s.redisOk) {
          push(ctx, await tryPatchSecret('databases', 'redis', { 'redis-password': s.redisPassword }));
        } else {
          push(ctx, { key: 'databases/redis', ok: false, detail: 'skipped: redis CONFIG SET did not succeed' });
        }
      },
    },
    {
      name: 'argocd-password',
      async run(ctx) {
        const s = ctx.state;
        try {
          const hash = await bcrypt.hash(s.argocd, 10);
          const patched = await tryPatchSecret('argocd', 'argocd-secret', {
            'admin.password': hash,
            'admin.passwordMtime': new Date().toISOString(),
          });
          push(ctx, patched);
          if (patched.ok) {
            s.values.ARGOCD_ADMIN_PASSWORD = s.argocd;
            push(ctx, await tryPatchSecret('argocd', 'argocd-initial-admin-secret', { password: s.argocd }));
          }
        } catch (err: any) {
          push(ctx, { key: 'argocd/argocd-secret', ok: false, detail: err?.message || 'argocd password hash failed' });
        }
      },
    },
    {
      name: 'finalize',
      async run(ctx) {
        const s = ctx.state;
        if (s.pgOk && s.redisOk) {
          try {
            await clearRotatePending();
            push(ctx, { key: 'platform/platform-rotate-pending', ok: true, detail: 'cleared after successful rotate' });
          } catch (err: any) {
            push(ctx, {
              key: 'platform/platform-rotate-pending',
              ok: false,
              detail: err?.message || 'could not clear rotate-pending secret',
            });
          }
        }
        // Emitted through the outbox: sent only once this step has committed.
        ctx.emit('notify.roles', {
          roles: [UserRole.ADMIN, UserRole.DEVOPS],
          title: 'Platform secrets rotated',
          body: 'Admin and live datastore credentials were rotated. New values are stored in the platform-credentials Kubernetes Secret (and shown once here); `platformctl update` refreshes the host break-glass copy.',
          kind: 'security',
          link: '/settings',
          metadata: { actorUserId: s.actorUserId, operationId: ctx.operationId },
        });
      },
    },
    {
      name: 'restart-api',
      // Restarting ourselves can kill this run; never repeat it after a restart.
      onResume: 'skip',
      async run(ctx) {
        try {
          await restartNamedDeployment('platform', 'platform-api');
          push(ctx, { key: 'restart:platform/platform-api', ok: true, detail: 'rollout restarted' });
        } catch (err: any) {
          push(ctx, { key: 'restart:platform/platform-api', ok: false, detail: err?.message || 'restart failed' });
        }
      },
    },
  ],
});

export type RotatePlatformSecretsResult = {
  results: RotateResult[];
  values: Record<string, string>;
  operationId: string;
  status: string;
};

/**
 * Rotate credentials that can be changed live, then patch matching Kubernetes
 * secrets. Mongo/MinIO/Portainer passwords are not written to platform-env
 * unless those servers were updated — otherwise the API crash-loops on restart.
 *
 * Write-ahead: old+new passwords are stored in platform-rotate-pending before
 * ALTER USER / CONFIG SET. If this process dies or TypeORM cannot reconnect,
 * the next API boot tries every stored copy and syncs secrets to whichever
 * password still authenticates — no host SSH required — and the operation
 * worker resumes the rotation from its persisted step log.
 *
 * Runs under the platform-wide `lock:platform:secret-rotation` lock; throws
 * LockBusyError when another rotation is in progress.
 */
export async function rotatePlatformSecrets(opts: {
  actorUserId?: string;
  /** Lock already taken by the caller (its holder must be `operationId`). */
  lock?: LockHandle;
  operationId?: string;
}): Promise<RotatePlatformSecretsResult> {
  const id = opts.operationId || newOperationId();
  const lock = opts.lock || await acquireLockOrThrow(SECRET_ROTATION_LOCK_KEY, { holder: id, ttlMs: 60_000 });
  const state: RotationState = {
    actorUserId: opts.actorUserId || '',
    admin: randomSecret(12),
    webhook: randomSecret(),
    postgres: randomSecret(),
    redisPassword: randomSecret(),
    argocd: randomSecret(12),
    previousPostgres: process.env.POSTGRES_PASSWORD || '',
    previousRedis: process.env.REDIS_PASSWORD || '',
    adminOk: false,
    redisOk: false,
    pgOk: false,
    results: [],
    values: {},
  };
  const run = await executeOperation<RotationState>(SECRET_ROTATION_OPERATION, {
    id,
    lockKey: SECRET_ROTATION_LOCK_KEY,
    input: { kind: 'secret-rotation' },
    state,
    createdById: opts.actorUserId || null,
    lock,
  });
  const final = run.state as RotationState;
  return {
    results: final.results || [],
    values: final.values || {},
    operationId: run.operation.id,
    status: run.operation.status,
  };
}
