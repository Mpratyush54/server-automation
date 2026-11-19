/**
 * Project deletion as a resumable, step-logged background operation (lib/operations.ts).
 *
 *  1. prepare            hide the project, stop deploys/builds/SDK calls, list what it owns
 *  2. lock-databases     refuse new database connections so the backup is consistent
 *  3. back-up-databases  back up every database to the configured backup target
 *     -- nothing has been removed up to here: a failure restores the project (onFailed) --
 *  4. stop-apps          Argo CD Applications (cascade), previews, running builds
 *  5. remove-namespaces  every project namespace (workloads, ingresses, certificates, secrets…)
 *  6. remove-monitoring  synthetic checks, alert rules and their cluster objects, status page
 *  7. revoke-access      SDK tokens, secrets and variables, pending agent approvals
 *  8. remove-databases   drop (deleteDatabases) or keep detached and locked
 *  9. remove-data        telemetry, replays, heatmaps, files, registry images…
 * 10. finish             mark the project deleted: its name is free again
 *
 * Every step is idempotent. A failed delete is retried by calling DELETE again: a new
 * operation starts with the previous one's state, so backups that already completed are not
 * repeated and nothing is restored once removal has begun. Each destructive step writes an
 * audit log entry.
 */
import { getDb } from '../config/database';
import { Project } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { ProjectMember } from '../entities/ProjectMember';
import { SdkCredential } from '../entities/SdkCredential';
import { Secret } from '../entities/Secret';
import { SecretVersion } from '../entities/SecretVersion';
import { AgentCommandApproval } from '../entities/AgentCommandApproval';
import { logAudit } from '../middleware/auth';
import { acquireLockOrThrow, projectLockKey } from './locks';
import { createOperation, defineOperation, newOperationId, publicOperation, resolveOperationStore, runOperation } from './operations';
import type { OperationRecord } from './operation-store';
import { In, Not } from 'typeorm';
import * as resources from './project-delete-resources';
import type { DatabaseBackup, ProjectDatabase, RemoveOutcome } from './project-delete-resources';

export const PROJECT_DELETE_OPERATION = 'project.delete';

export interface ProjectDeleteState extends Record<string, unknown> {
  projectId: string;
  projectName: string;
  /** Who asked, for the audit entries written by the steps. */
  actorUserId: string | null;
  /** The project was active before this delete (restored if the delete aborts early). */
  wasActive?: boolean;
  namespaces?: string[];
  databases?: ProjectDatabase[];
  /** Databases locked by lock-databases (keys from dbKey). */
  locked?: string[];
  backups?: Record<string, DatabaseBackup>;
  /** Set when the first destructive step starts; from then on nothing is restored. */
  removalStarted?: boolean;
  databasesOutcome?: 'dropped' | 'detached';
  removed?: Record<string, unknown>;
}

/** Cluster, database and storage side effects (tests replace them). */
export type ProjectDeleteDeps = {
  listProjectDatabases: typeof resources.listProjectDatabases;
  projectNamespacesFor: typeof resources.projectNamespacesFor;
  lockDatabase: typeof resources.lockDatabase;
  unlockDatabase: typeof resources.unlockDatabase;
  backupDatabase: typeof resources.backupDatabase;
  dropDatabase: typeof resources.dropDatabase;
  removeArgoApplications: typeof resources.removeArgoApplications;
  removeNamespaces: typeof resources.removeNamespaces;
  removeLegacyPreviews: typeof resources.removeLegacyPreviews;
  removeRegistryImages: typeof resources.removeRegistryImages;
  removeUploadedFiles: typeof resources.removeUploadedFiles;
  removeReplayObjects: typeof resources.removeReplayObjects;
  removeProjectData: typeof resources.removeProjectData;
  removeMonitoring: (projectId: string) => Promise<Record<string, number>>;
  /** Other operations of the project still running (deploys, builds): wait for them. */
  activeProjectOperations: (projectId: string, exceptId: string) => Promise<string[]>;
};

const realDeps: ProjectDeleteDeps = {
  listProjectDatabases: resources.listProjectDatabases,
  projectNamespacesFor: resources.projectNamespacesFor,
  lockDatabase: resources.lockDatabase,
  unlockDatabase: resources.unlockDatabase,
  backupDatabase: resources.backupDatabase,
  dropDatabase: resources.dropDatabase,
  removeArgoApplications: resources.removeArgoApplications,
  removeNamespaces: resources.removeNamespaces,
  removeLegacyPreviews: resources.removeLegacyPreviews,
  removeRegistryImages: resources.removeRegistryImages,
  removeUploadedFiles: resources.removeUploadedFiles,
  removeReplayObjects: resources.removeReplayObjects,
  removeProjectData: resources.removeProjectData,
  removeMonitoring,
  activeProjectOperations,
};
let deps: ProjectDeleteDeps = realDeps;

export function setProjectDeleteDepsForTests(overrides: Partial<ProjectDeleteDeps> | null): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
}

async function audit(state: ProjectDeleteState, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await logAudit({ userId: state.actorUserId || undefined, action, targetType: 'Project', targetId: state.projectId, metadata: { projectName: state.projectName, ...metadata } });
}

async function loadProject(projectId: string): Promise<Project> {
  const project = await (await getDb()).getRepository(Project).findOne({ where: { id: projectId } });
  if (!project) throw new Error('Project not found');
  return project;
}

const where = (db: ProjectDatabase) => `${db.kind} ${db.name} (${db.environment})`;

// ── monitoring ───────────────────────────────────────────────────────────────

/** Synthetic checks, alerting configuration and the status page, with their cluster objects. */
async function removeMonitoring(projectId: string): Promise<Record<string, number>> {
  const ds = await getDb();
  const out: Record<string, number> = {};
  const { SyntheticCheck } = await import('../entities/SyntheticCheck');
  const { SyntheticResult } = await import('../entities/SyntheticResult');
  const { deleteCheckResources } = await import('./synthetic-k8s');
  const { getUploadStore } = await import('./upload-store');
  const checks = await ds.getRepository(SyntheticCheck).find({ where: { projectId } });
  for (const check of checks) {
    const shots = await ds.getRepository(SyntheticResult).find({ where: { checkId: check.id }, select: { id: true, screenshotKey: true } as any });
    for (const s of shots) if ((s as any).screenshotKey) { try { await getUploadStore().delete((s as any).screenshotKey); } catch { /* best effort */ } }
    await ds.getRepository(SyntheticResult).delete({ checkId: check.id });
    await deleteCheckResources(check.id);
    await ds.getRepository(SyntheticCheck).delete({ id: check.id });
  }
  out.syntheticChecks = checks.length;

  const { ALERTING_ENTITIES } = await import('../entities/alerting-entities');
  const { Alert } = await import('../entities/Alert');
  const { AlertSilence } = await import('../entities/AlertSilence');
  const { expireMirroredSilence, syncProjectRules } = await import('./alerting-k8s');
  for (const s of await ds.getRepository(AlertSilence).find({ where: { projectId } })) {
    try { await expireMirroredSilence(s.alertmanagerId ?? null); } catch (err: any) {
      console.warn(`[project-delete] silence expire failed: ${err?.message || err}`);
    }
  }
  // Children first (deliveries -> incidents -> ... -> channels).
  for (const entity of [...ALERTING_ENTITIES].reverse().concat([Alert as any])) {
    const r: any = await ds.getRepository(entity as any).delete({ projectId } as any);
    out[(entity as any).name] = r?.affected ?? 0;
  }
  // With no monitors or SLOs left, this removes the PrometheusRule, AlertmanagerConfig and Loki rules.
  const { alertingMode } = await import('./alerting-config');
  if (alertingMode() === 'ruler') await syncProjectRules(projectId);

  const { StatusPage } = await import('../entities/StatusPage');
  const { StatusIncident } = await import('../entities/StatusIncident');
  const { invalidatePublicCache } = await import('./status-page');
  const pages = await ds.getRepository(StatusPage).find({ where: { projectId } });
  out.statusIncidents = (await ds.getRepository(StatusIncident).delete({ projectId } as any))?.affected ?? 0;
  for (const p of pages) {
    await ds.getRepository(StatusPage).delete({ id: p.id });
    if ((p as any).slug) await invalidatePublicCache((p as any).slug).catch(() => {});
  }
  out.statusPages = pages.length;
  return out;
}

async function activeProjectOperations(projectId: string, exceptId: string): Promise<string[]> {
  const store = await resolveOperationStore();
  const ops = await store.list({ projectId, limit: 100 });
  return ops.filter((o) => o.id !== exceptId && o.type !== PROJECT_DELETE_OPERATION && !['succeeded', 'failed', 'compensated'].includes(o.status)).map((o) => o.id);
}

// ── operation ────────────────────────────────────────────────────────────────

export const projectDeleteOperation = defineOperation<ProjectDeleteState>({
  type: PROJECT_DELETE_OPERATION,
  resume: 'continue',
  summarize: (s) => ({
    projectName: s.projectName,
    databases: (s.databases || []).map((d) => ({ kind: d.kind, environment: d.environment, name: d.name })),
    backups: Object.values(s.backups || {}).map((b) => ({ kind: b.kind, environment: b.environment, name: b.name, status: b.status, backupId: b.backupId, fileId: b.fileId })),
    databasesOutcome: s.databasesOutcome ?? null,
    removalStarted: !!s.removalStarted,
  }),
  async onFailed(ctx, error) {
    const s = ctx.state;
    if (s.removalStarted) {
      await audit(s, 'project.delete.failed', { operationId: ctx.operationId, error });
      return;
    }
    // Nothing was removed: give the project back, unlocked, exactly as it was.
    for (const db of s.databases || []) {
      if (!(s.locked || []).includes(resources.dbKey(db))) continue;
      try { await deps.unlockDatabase(db); } catch (err: any) {
        console.warn(`[project-delete] could not unlock ${where(db)}: ${err?.message || err}`);
      }
    }
    if (s.wasActive) {
      await (await getDb()).getRepository(Project).update({ id: s.projectId }, { isActive: true });
      const { requestTelemetryOriginsSync } = await import('./telemetry-origins');
      requestTelemetryOriginsSync();
    }
    await audit(s, 'project.delete.aborted', { operationId: ctx.operationId, error, note: 'Nothing was deleted' });
  },
  steps: [
    {
      name: 'prepare',
      async run(ctx) {
        const s = ctx.state;
        const repo = (await getDb()).getRepository(Project);
        const project = await loadProject(s.projectId);
        if (s.wasActive === undefined) s.wasActive = project.isActive !== false && !project.deletedAt;
        if (project.isActive !== false) await repo.update({ id: project.id }, { isActive: false });
        const { requestTelemetryOriginsSync } = await import('./telemetry-origins');
        requestTelemetryOriginsSync(); // browsers of a hidden project lose CORS
        s.namespaces = await deps.projectNamespacesFor(project.id);
        // A retry keeps the databases found before (some may already be dropped).
        if (!s.databases) s.databases = await deps.listProjectDatabases(project);
        ctx.setOutput({ namespaces: s.namespaces.length, databases: s.databases.length });
      },
    },
    {
      name: 'lock-databases',
      async run(ctx) {
        const s = ctx.state;
        s.locked = s.locked || [];
        for (const db of s.databases || []) {
          const key = resources.dbKey(db);
          if (s.backups?.[key] || s.locked.includes(key)) continue;
          await deps.lockDatabase(db);
          s.locked.push(key);
        }
        ctx.setOutput({ locked: s.locked.length });
      },
    },
    {
      name: 'back-up-databases',
      async run(ctx) {
        const s = ctx.state;
        s.backups = s.backups || {};
        const failures: string[] = [];
        for (const db of s.databases || []) {
          const key = resources.dbKey(db);
          if (s.backups[key]) continue; // done by this or an earlier attempt
          try {
            s.backups[key] = await deps.backupDatabase(s.projectId, db, ctx.operationId);
          } catch (err: any) {
            failures.push(`${where(db)}: ${String(err?.message || err).slice(0, 300)}`);
          }
        }
        ctx.setOutput({ backups: Object.keys(s.backups).length, failed: failures.length });
        if (failures.length) {
          throw new Error(`Backup failed, nothing was deleted. ${failures.join('; ')}`);
        }
        await audit(s, 'project.delete.backed_up', {
          operationId: ctx.operationId,
          backups: Object.values(s.backups).map((b) => ({ kind: b.kind, environment: b.environment, name: b.name, status: b.status, backupId: b.backupId, fileId: b.fileId, provider: b.providerType })),
        });
      },
    },
    {
      name: 'stop-apps',
      async run(ctx) {
        const s = ctx.state;
        // Deploys and builds already running would recreate what this removes: wait for them.
        const running = await deps.activeProjectOperations(s.projectId, ctx.operationId);
        if (running.length) ctx.defer(Date.now() + 15_000, `waiting for ${running.length} running deploy or build operation(s)`);
        if (!s.removalStarted) {
          s.removalStarted = true;
          await audit(s, 'project.delete.removal_started', { operationId: ctx.operationId, deleteDatabases: !!ctx.input.deleteDatabases });
        }
        const apps = await deps.removeArgoApplications(s.projectId, s.namespaces || []);
        const previews = await deps.removeLegacyPreviews(s.projectId);
        const images = await deps.removeRegistryImages(s.projectId);
        ctx.setOutput({ argoApplications: Object.keys(apps).length, previews, images });
        await audit(s, 'project.delete.apps_removed', { operationId: ctx.operationId, argoApplications: apps, legacyPreviews: previews, registryImages: images });
      },
    },
    {
      name: 'remove-namespaces',
      async run(ctx) {
        const s = ctx.state;
        const result = await deps.removeNamespaces(s.projectId, s.namespaces || []);
        const kept = Object.entries(result).filter(([, o]) => o === 'not-owned' || o === 'reserved').map(([ns]) => ns);
        ctx.setOutput({ namespaces: result });
        await audit(s, 'project.delete.namespaces_removed', { operationId: ctx.operationId, namespaces: result, keptBecauseNotOwned: kept });
      },
    },
    {
      name: 'remove-monitoring',
      async run(ctx) {
        const s = ctx.state;
        const result = await deps.removeMonitoring(s.projectId);
        ctx.setOutput(result);
        await audit(s, 'project.delete.monitoring_removed', { operationId: ctx.operationId, ...result });
      },
    },
    {
      name: 'revoke-access',
      async run(ctx) {
        const s = ctx.state;
        const ds = await getDb();
        const tokens = await ds.getRepository(SdkCredential).update({ projectId: s.projectId, status: Not('revoked') }, { status: 'revoked' });
        const secrets = await ds.getRepository(Secret).find({ where: { projectId: s.projectId }, select: { id: true } as any });
        if (secrets.length) await ds.getRepository(SecretVersion).delete({ secretId: In(secrets.map((x) => x.id)) });
        const removedSecrets = (await ds.getRepository(Secret).delete({ projectId: s.projectId }))?.affected ?? 0;
        // Agent approvals are not tied to a project; expire pending ones aimed at its namespaces.
        let approvals = 0;
        const namespaces = (s.namespaces || []).filter((ns) => ns.length >= 8);
        if (namespaces.length) {
          const repo = ds.getRepository(AgentCommandApproval);
          for (const a of await repo.find({ where: { status: 'pending' } })) {
            if (!namespaces.some((ns) => a.command.includes(ns))) continue;
            await repo.update({ id: a.id }, { status: 'expired', reason: 'Project deleted' });
            approvals++;
          }
        }
        ctx.setOutput({ sdkTokens: tokens?.affected ?? 0, secrets: removedSecrets, agentApprovals: approvals });
        await audit(s, 'project.delete.access_revoked', { operationId: ctx.operationId, sdkTokens: tokens?.affected ?? 0, secrets: removedSecrets, agentApprovals: approvals });
      },
    },
    {
      name: 'remove-databases',
      async run(ctx) {
        const s = ctx.state;
        const dbs = s.databases || [];
        if (ctx.input.deleteDatabases === true) {
          for (const db of dbs) {
            const backup = s.backups?.[resources.dbKey(db)];
            // Never drop a database without a completed backup of it.
            if (!backup) throw new Error(`No backup of ${where(db)}; refusing to drop it`);
            await deps.dropDatabase(db);
          }
          s.databasesOutcome = 'dropped';
          await audit(s, 'project.delete.databases_dropped', {
            operationId: ctx.operationId,
            databases: dbs.map((db) => ({ kind: db.kind, environment: db.environment, name: db.name, backupId: s.backups?.[resources.dbKey(db)]?.backupId ?? null })),
          });
        } else {
          // Kept, locked (no login) and detached: the names derive from this project's id, so a
          // later project, whatever its name, can never be handed these databases.
          s.databasesOutcome = 'detached';
          await audit(s, 'project.delete.databases_detached', {
            operationId: ctx.operationId,
            note: 'Kept with logins disabled. Recover from the listed backup, or re-enable the user as an administrator.',
            databases: dbs.map((db) => ({
              kind: db.kind, environment: db.environment, database: db.name, user: db.user,
              ...(db.keyPrefix ? { keyPrefix: db.keyPrefix } : {}),
              backupId: s.backups?.[resources.dbKey(db)]?.backupId ?? null,
            })),
          });
        }
        ctx.setOutput({ databases: dbs.length, outcome: s.databasesOutcome });
      },
    },
    {
      name: 'remove-data',
      async run(ctx) {
        const s = ctx.state;
        const ds = await getDb();
        // Legacy SDK data is keyed by name: only remove it when no other project used the name.
        const sameName = await ds.getRepository(Project).findOne({ where: { name: s.projectName, id: Not(s.projectId) } });
        const files = await deps.removeUploadedFiles(s.projectId);
        const replayObjects = await deps.removeReplayObjects(s.projectId);
        const rows = await deps.removeProjectData(s.projectId, sameName ? null : s.projectName);
        s.removed = { files, replayObjects, ...rows };
        ctx.setOutput({ files, replayObjects });
        await audit(s, 'project.delete.data_removed', { operationId: ctx.operationId, files, replayObjects, rows });
      },
    },
    {
      name: 'finish',
      async run(ctx) {
        const s = ctx.state;
        const ds = await getDb();
        await ds.getRepository(Environment).update({ projectId: s.projectId }, { isActive: false, buildOnPush: false });
        await ds.getRepository(ProjectMember).delete({ projectId: s.projectId });
        const project = await loadProject(s.projectId);
        await ds.getRepository(Project).update({ id: s.projectId }, { isActive: false, deletedAt: project.deletedAt || new Date() });
        const { requestTelemetryOriginsSync } = await import('./telemetry-origins');
        requestTelemetryOriginsSync();
        await audit(s, 'project.deleted', {
          operationId: ctx.operationId,
          databases: s.databasesOutcome,
          backups: Object.values(s.backups || {}).map((b) => ({ kind: b.kind, environment: b.environment, name: b.name, backupId: b.backupId })),
        });
      },
    },
  ],
});

// ── start / status ───────────────────────────────────────────────────────────

export class ProjectDeleteConflict extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) { super(message); }
}

const TERMINAL = new Set(['succeeded', 'failed', 'compensated']);

export async function latestProjectDelete(projectId: string): Promise<OperationRecord | null> {
  const store = await resolveOperationStore();
  const [latest] = await store.list({ projectId, type: PROJECT_DELETE_OPERATION, limit: 1 });
  return latest || null;
}

/**
 * Start (or resume) deleting a project. Returns the running operation when one exists; after a
 * failed attempt a new operation continues from the previous state.
 */
export async function startProjectDelete(opts: {
  project: Project;
  deleteDatabases: boolean;
  actorUserId: string | null;
}): Promise<{ operationId: string; resumed: boolean; alreadyRunning: boolean }> {
  const { project } = opts;
  const previous = await latestProjectDelete(project.id);
  if (previous && !TERMINAL.has(previous.status)) {
    return { operationId: previous.id, resumed: false, alreadyRunning: true };
  }
  if (previous?.status === 'succeeded') {
    throw new ProjectDeleteConflict('This project is already deleted', 'project_already_deleted');
  }
  const carry = previous && (previous.state as ProjectDeleteState)?.removalStarted ? (previous.state as ProjectDeleteState) : null;
  const id = newOperationId();
  const lockKey = projectLockKey(project.id, 'delete');
  const lock = await acquireLockOrThrow(lockKey, { holder: id });
  let handedOff = false;
  try {
    const state: ProjectDeleteState = carry
      ? { ...carry, actorUserId: opts.actorUserId }
      : { projectId: project.id, projectName: project.name, actorUserId: opts.actorUserId };
    await createOperation<ProjectDeleteState>(PROJECT_DELETE_OPERATION, {
      id, projectId: project.id, lockKey,
      input: { deleteDatabases: opts.deleteDatabases, ...(carry ? { retryOf: previous!.id } : {}) },
      state, createdById: opts.actorUserId,
    });
    await logAudit({
      userId: opts.actorUserId || undefined, action: carry ? 'project.delete.retried' : 'project.delete.started',
      targetType: 'Project', targetId: project.id,
      metadata: { projectName: project.name, operationId: id, deleteDatabases: opts.deleteDatabases, ...(carry ? { retryOf: previous!.id } : {}) },
    });
    handedOff = true;
    setImmediate(() => {
      runOperation(id, { lock }).catch((err) => console.error('[project-delete]', err?.message || err));
    });
    return { operationId: id, resumed: !!carry, alreadyRunning: false };
  } finally {
    if (!handedOff) await lock.release();
  }
}

/** Plain status of a project's deletion for the API and portal. */
export function deletionView(op: OperationRecord | null): Record<string, unknown> {
  if (!op) return { status: 'none', operation: null };
  const s = (op.state || {}) as ProjectDeleteState;
  let status: string;
  if (op.status === 'succeeded') status = 'deleted';
  else if (!TERMINAL.has(op.status)) status = 'running';
  else status = s.removalStarted ? 'failed' : 'aborted';
  return { status, deleteDatabases: op.input?.deleteDatabases === true, operation: publicOperation(op) };
}

export type { RemoveOutcome };
