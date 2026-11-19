/**
 * Resource layer of project deletion (lib/project-delete.ts): finds and removes what a project
 * created in the cluster, in the databases and in object storage. Every function is idempotent
 * (a resource that is already gone counts as removed) and verifies ownership by the immutable
 * project id before deleting anything, so a resource of another project, or one a later project
 * with the same name owns, is never touched.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as k8s from '@kubernetes/client-node';
import { Pool } from 'pg';
import { In } from 'typeorm';
import { getDb } from '../config/database';
import { loadKubeConfig } from './kube-config';
import { isReservedNamespace } from './namespace-baseline';
import { previewNamespace } from './k8s';
import { projectDbIdentity } from './project-db-identity';
import { Project } from '../entities/Project';
import { Environment } from '../entities/Environment';
import { Secret } from '../entities/Secret';
import { StorageProvider } from '../entities/StorageProvider';

export type DatabaseKind = 'postgres' | 'mongo' | 'redis';

/** One database (or Redis key space) a project owns. Names only, never credentials. */
export interface ProjectDatabase {
  kind: DatabaseKind;
  environment: string;
  /** Postgres/Mongo database name; Redis ACL user. */
  name: string;
  /** Postgres role / Mongo user / Redis ACL user. */
  user: string;
  /** Redis only: the key prefix the ACL user is confined to. */
  keyPrefix?: string;
}

export interface DatabaseBackup {
  key: string;
  kind: DatabaseKind;
  environment: string;
  name: string;
  /** db_backups row (Postgres dumps and the logical exports of MongoDB / Redis). */
  backupId: string | null;
  status: 'completed' | 'empty' | 'absent';
  fileId: string | null;
  providerType: string | null;
  sizeBytes: number;
}

export const dbKey = (db: Pick<ProjectDatabase, 'kind' | 'environment' | 'name'>) => `${db.kind}:${db.environment}:${db.name}`;

const notFound = (e: any) => Number(e?.code ?? e?.statusCode ?? e?.response?.statusCode ?? e?.body?.code) === 404;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_LABEL = 'platform.io/project';

// ── inventory ────────────────────────────────────────────────────────────────

/** Namespaces of the project's environments plus its preview namespace (deduplicated). */
export async function projectNamespacesFor(projectId: string): Promise<string[]> {
  const ds = await getDb();
  const envs = await ds.getRepository(Environment).find({ where: { projectId } });
  const out = new Set<string>();
  for (const e of envs) if (e.namespace) out.add(e.namespace);
  out.add(previewNamespace(projectId));
  return [...out];
}

function decrypt(value: string): string | null {
  try {
    // Lazy: project-db-ensure pulls in the Postgres admin pool.
    const { decryptStoredSecret } = require('./project-db-ensure') as typeof import('./project-db-ensure');
    return decryptStoredSecret(value);
  } catch {
    return null;
  }
}

/**
 * Databases the project owns: Postgres from projects.database_resources, MongoDB and Redis from
 * the credentials stored for each environment. A MongoDB or Redis identity is only accepted
 * when it is the id-derived one (projectDbIdentity), so nothing the platform or another project
 * uses can end up on this list.
 */
export async function listProjectDatabases(project: Pick<Project, 'id' | 'databaseResources'>): Promise<ProjectDatabase[]> {
  const out: ProjectDatabase[] = [];
  const platformDb = process.env.POSTGRES_DB || 'plat_platform';
  const platformUser = process.env.POSTGRES_USER || 'postgres';
  const reservedDbs = new Set([platformDb, 'postgres', 'template0', 'template1']);
  for (const [environment, res] of Object.entries(project.databaseResources || {})) {
    if (!res?.dbName || !res?.username) continue;
    if (reservedDbs.has(res.dbName) || [platformUser, 'postgres'].includes(res.username)) continue;
    out.push({ kind: 'postgres', environment, name: res.dbName, user: res.username });
  }
  const ds = await getDb();
  const secrets = await ds.getRepository(Secret).find({
    where: { projectId: project.id, key: In(['MONGO_DB', 'MONGO_USER', 'REDIS_USERNAME', 'REDIS_KEY_PREFIX']) },
  });
  const byEnv: Record<string, Record<string, string>> = {};
  for (const s of secrets) {
    const env = s.environmentId || '';
    if (!env) continue;
    const value = decrypt(s.encryptedValue);
    if (value === null) continue;
    byEnv[env] = { ...(byEnv[env] || {}), [s.key]: value };
  }
  for (const [environment, v] of Object.entries(byEnv)) {
    const { id, env } = projectDbIdentity(project.id, environment);
    if (v.MONGO_DB === `plat_${id}_${env}` && v.MONGO_USER === `plat_${id}_${env}_user`) {
      out.push({ kind: 'mongo', environment, name: v.MONGO_DB, user: v.MONGO_USER });
    }
    if (v.REDIS_USERNAME === `plat_${id}_${env}` && v.REDIS_KEY_PREFIX === `plat:${id}:${env}:`) {
      out.push({ kind: 'redis', environment, name: v.REDIS_USERNAME, user: v.REDIS_USERNAME, keyPrefix: v.REDIS_KEY_PREFIX });
    }
  }
  return out;
}

// ── Postgres ─────────────────────────────────────────────────────────────────

function pgAdmin(): Pool {
  return new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: 'postgres',
    max: 1,
  });
}

async function withPg<T>(fn: (c: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const pool = pgAdmin();
  try {
    const client = await pool.connect();
    try { return await fn(client); } finally { client.release(); }
  } finally { await pool.end(); }
}

async function pgExists(db: ProjectDatabase): Promise<{ db: boolean; role: boolean }> {
  return withPg(async (c) => ({
    db: (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.name])).rows.length > 0,
    role: (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [db.user])).rows.length > 0,
  }));
}

// ── MongoDB / Redis connections ──────────────────────────────────────────────

async function withMongo<T>(fn: (client: any) => Promise<T>): Promise<T> {
  const mongoose = await import('mongoose');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/plat_platform';
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5000 });
  conn.on('error', () => {});
  try {
    await conn.asPromise();
    return await fn(conn.getClient());
  } finally {
    await conn.close().catch(() => {});
  }
}

/** Run on every Redis data node; throws unless the master succeeded. */
async function onRedisNodes(fn: (client: any, role: 'master' | 'replica') => Promise<void>): Promise<void> {
  const { forEachRedisDataNode } = await import('./redis-endpoint');
  const result = await forEachRedisDataNode(process.env.REDIS_PASSWORD || '', (client, node) => fn(client, node.role));
  if (!result.ok.length) throw new Error(result.failed[0]?.error || 'Redis is unavailable');
  if (result.failed.length) console.warn(`[project-delete] Redis node failures: ${result.failed.map((f) => `${f.node}: ${f.error}`).join('; ')}`);
}

async function redisScanKeys(client: any, prefix: string, each: (keys: string[]) => Promise<void>): Promise<number> {
  let cursor = '0';
  let total = 0;
  const pattern = `${prefix.replace(/[*?[\]\\]/g, '\\$&')}*`;
  do {
    const [next, keys] = await client.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', '500') as [string, string[]];
    cursor = String(next);
    // SCAN MATCH is a glob; re-check the literal prefix before touching a key.
    const own = (keys || []).filter((k: string) => k.startsWith(prefix));
    if (own.length) { total += own.length; await each(own); }
  } while (cursor !== '0');
  return total;
}

// ── lock / unlock (reversible: run before the backup so it is consistent) ───

/** Stop new connections and end the open ones. Returns false when the database does not exist. */
export async function lockDatabase(db: ProjectDatabase): Promise<boolean> {
  if (db.kind === 'postgres') {
    const exists = await pgExists(db);
    if (exists.role) {
      await withPg(async (c) => {
        await c.query(`ALTER ROLE ${c.escapeIdentifier(db.user)} NOLOGIN`);
        await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()', [db.user]);
      });
    }
    return exists.db;
  }
  if (db.kind === 'mongo') {
    return withMongo(async (client) => {
      const info: any = await client.db(db.name).command({ usersInfo: db.user });
      if (Array.isArray(info?.users) && info.users.length) {
        await client.db(db.name).command({ revokeRolesFromUser: db.user, roles: [{ role: 'readWrite', db: db.name }] });
      }
      const list: any = await client.db('admin').admin().listDatabases({ nameOnly: true });
      return (list?.databases || []).some((d: any) => d.name === db.name);
    });
  }
  await onRedisNodes(async (client) => {
    const users: string[] = await client.call('ACL', 'USERS');
    if (!users.includes(db.user)) return;
    await client.call('ACL', 'SETUSER', db.user, 'off');
    await Promise.resolve(client.call('CLIENT', 'KILL', 'USER', db.user)).catch(() => {});
    await Promise.resolve(client.call('ACL', 'SAVE')).catch(() => {});
  });
  return true; // keys under the prefix may exist even without the ACL user
}

/** Undo lockDatabase (only used when the delete is aborted before anything was removed). */
export async function unlockDatabase(db: ProjectDatabase): Promise<void> {
  if (db.kind === 'postgres') {
    const exists = await pgExists(db);
    if (exists.role) await withPg(async (c) => { await c.query(`ALTER ROLE ${c.escapeIdentifier(db.user)} LOGIN`); });
    return;
  }
  if (db.kind === 'mongo') {
    await withMongo(async (client) => {
      const info: any = await client.db(db.name).command({ usersInfo: db.user });
      if (Array.isArray(info?.users) && info.users.length) {
        await client.db(db.name).command({ grantRolesToUser: db.user, roles: [{ role: 'readWrite', db: db.name }] });
      }
    });
    return;
  }
  await onRedisNodes(async (client) => {
    const users: string[] = await client.call('ACL', 'USERS');
    if (!users.includes(db.user)) return;
    await client.call('ACL', 'SETUSER', db.user, 'on');
    await Promise.resolve(client.call('ACL', 'SAVE')).catch(() => {});
  });
}

// ── backup (the same target and db_backups records as manual backups) ───────

async function backupTarget() {
  const ds = await getDb();
  const provider = await ds.getRepository(StorageProvider).findOne({ where: { isDefault: true } });
  const storage = await import('./storage-service');
  const adapter = provider
    ? storage.createAdapter(provider.providerType, provider.credentials || {}, provider.bucketName || undefined, provider.endpointUrl || undefined)
    : storage.createDefaultBackupAdapter();
  return { adapter, providerType: (provider?.providerType as string) || storage.defaultBackupProviderType(), providerId: provider?.id || null };
}

/** Write a MongoDB database as gzipped extended-JSON lines: one {c: collection, d: document} per line. */
async function exportMongo(db: ProjectDatabase, file: string): Promise<number> {
  const mongoose = await import('mongoose');
  const { EJSON } = (mongoose as any).mongo.BSON;
  return withMongo(async (client) => {
    const gz = zlib.createGzip();
    const out = fs.createWriteStream(file);
    gz.pipe(out);
    let count = 0;
    const write = (line: string) => new Promise<void>((resolve) => { if (gz.write(line)) resolve(); else gz.once('drain', resolve); });
    for (const coll of await client.db(db.name).listCollections({}, { nameOnly: true }).toArray()) {
      if (String(coll.name).startsWith('system.')) continue;
      for await (const doc of client.db(db.name).collection(coll.name).find({})) {
        await write(`${EJSON.stringify({ c: coll.name, d: doc }, { relaxed: false })}\n`);
        count++;
      }
    }
    await new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); gz.end(); });
    return count;
  });
}

/** Write a Redis key space as gzipped JSON lines: one {k, ttl, v: base64 DUMP} per key. */
async function exportRedis(db: ProjectDatabase, file: string): Promise<number> {
  const lines: string[] = [];
  await onRedisNodes(async (client, role) => {
    if (role !== 'master') return;
    await redisScanKeys(client, db.keyPrefix!, async (keys) => {
      for (const k of keys) {
        const v: Buffer | null = await client.dumpBuffer(k);
        if (!v) continue;
        const ttl = Number(await client.pttl(k));
        lines.push(JSON.stringify({ k, ttl: ttl > 0 ? ttl : 0, v: v.toString('base64') }));
      }
    });
  });
  fs.writeFileSync(file, zlib.gzipSync(lines.length ? `${lines.join('\n')}\n` : ''));
  return lines.length;
}

/**
 * Back up one database to the configured backup target and record it in db_backups (status
 * completed). Postgres uses pg_dump like a manual backup; MongoDB and Redis are written as
 * logical exports. Throws on any failure (the caller aborts the delete).
 */
export async function backupDatabase(projectId: string, db: ProjectDatabase, operationId: string): Promise<DatabaseBackup> {
  const base: DatabaseBackup = { key: dbKey(db), kind: db.kind, environment: db.environment, name: db.name, backupId: null, status: 'absent', fileId: null, providerType: null, sizeBytes: 0 };
  if (db.kind === 'postgres' && !(await pgExists(db)).db) return base;

  const ds = await getDb();
  const { DbBackup, BackupStatus } = await import('../entities/DbBackup');
  const repo = ds.getRepository(DbBackup);
  const target = await backupTarget();
  const ext = db.kind === 'postgres' ? 'dump' : `${db.kind}.jsonl.gz`;
  const row = await repo.save(repo.create({
    projectId, dbName: db.kind === 'postgres' ? db.name : `${db.kind}:${db.name}`.slice(0, 200), environment: db.environment.slice(0, 50),
    providerType: target.providerType as any, providerId: target.providerId, status: BackupStatus.IN_PROGRESS,
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-delete-'));
  const tmp = path.join(dir, `${row.id}.${ext}`);
  try {
    let items = -1;
    if (db.kind === 'postgres') {
      const { dumpDatabase } = await import('./database-service');
      const r = await dumpDatabase(db.name, tmp);
      if (!r.success) throw new Error(r.error || 'pg_dump failed');
    } else if (db.kind === 'mongo') {
      items = await exportMongo(db, tmp);
    } else {
      items = await exportRedis(db, tmp);
    }
    const { computeFileChecksum } = await import('./database-service');
    const checksum = await computeFileChecksum(tmp);
    const size = fs.statSync(tmp).size;
    const uploaded = await target.adapter.upload(tmp, `backups/${projectId}/project-delete-${operationId}/${row.id}.${ext}`);
    await repo.update(row.id, { status: BackupStatus.COMPLETED, fileId: uploaded.fileId, fileSizeBytes: size, checksum });
    return { ...base, backupId: row.id, status: items === 0 ? 'empty' : 'completed', fileId: uploaded.fileId, providerType: target.providerType, sizeBytes: size };
  } catch (err: any) {
    await repo.update(row.id, { status: BackupStatus.FAILED, errorMessage: String(err?.message || err).slice(0, 2000) }).catch(() => {});
    throw err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── drop ─────────────────────────────────────────────────────────────────────

export async function dropDatabase(db: ProjectDatabase): Promise<void> {
  if (db.kind === 'postgres') {
    const { dropProjectDb } = await import('./database-service');
    await dropProjectDb(db.name, db.user);
    return;
  }
  if (db.kind === 'mongo') {
    await withMongo(async (client) => {
      const info: any = await client.db(db.name).command({ usersInfo: db.user });
      if (Array.isArray(info?.users) && info.users.length) await client.db(db.name).command({ dropUser: db.user });
      await client.db(db.name).dropDatabase();
    });
    return;
  }
  await onRedisNodes(async (client, role) => {
    if (role === 'master') await redisScanKeys(client, db.keyPrefix!, async (keys) => { await client.call('UNLINK', ...keys); });
    const users: string[] = await client.call('ACL', 'USERS');
    if (users.includes(db.user)) await client.call('ACL', 'DELUSER', db.user);
    await Promise.resolve(client.call('ACL', 'SAVE')).catch(() => {});
  });
}

// ── cluster ──────────────────────────────────────────────────────────────────

function kube() {
  const kc = new k8s.KubeConfig();
  loadKubeConfig(kc);
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    net: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
  };
}

export type RemoveOutcome = 'deleted' | 'absent' | 'not-owned' | 'reserved';

const ARGO = { group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications' };
const ARGO_CASCADE_FINALIZER = 'resources-finalizer.argocd.argoproj.io';

/**
 * Delete every Argo CD Application whose destination is one of the project's namespaces, with
 * the cascade finalizer so Argo CD removes the workloads it created. Namespaces that do not
 * carry this project's id label are left alone.
 */
export async function removeArgoApplications(projectId: string, namespaces: string[]): Promise<Record<string, RemoveOutcome>> {
  const { core, custom } = kube();
  const owned = new Set<string>();
  for (const ns of namespaces) {
    if (isReservedNamespace(ns)) continue;
    try {
      const n: any = await core.readNamespace({ name: ns });
      if (n?.metadata?.labels?.[PROJECT_LABEL] === projectId) owned.add(ns);
    } catch (e) {
      // A namespace already gone may still be the target of an app this project created.
      if (notFound(e)) owned.add(ns); else throw e;
    }
  }
  const out: Record<string, RemoveOutcome> = {};
  let apps: any[] = [];
  try {
    const list: any = await custom.listNamespacedCustomObject(ARGO);
    apps = (list?.body || list)?.items || [];
  } catch (e) {
    if (notFound(e)) return out; // Argo CD not installed
    throw e;
  }
  for (const app of apps) {
    const name = app?.metadata?.name;
    const dest = app?.spec?.destination?.namespace;
    if (!name || !dest || !namespaces.includes(dest)) continue;
    if (!owned.has(dest)) { out[name] = 'not-owned'; continue; }
    try {
      const finalizers: string[] = app.metadata.finalizers || [];
      if (!finalizers.includes(ARGO_CASCADE_FINALIZER) && !app.metadata.deletionTimestamp) {
        app.metadata.finalizers = [...finalizers, ARGO_CASCADE_FINALIZER];
        await custom.replaceNamespacedCustomObject({ ...ARGO, name, body: app });
      }
      await custom.deleteNamespacedCustomObject({ ...ARGO, name });
      out[name] = 'deleted';
    } catch (e) {
      if (notFound(e)) out[name] = 'absent'; else throw e;
    }
  }
  return out;
}

/** Delete the project's namespaces (everything inside goes with them: workloads, ingresses, certificates, secrets, ConfigMaps, autoscalers). */
export async function removeNamespaces(projectId: string, namespaces: string[]): Promise<Record<string, RemoveOutcome>> {
  const { core } = kube();
  const out: Record<string, RemoveOutcome> = {};
  for (const ns of namespaces) {
    if (isReservedNamespace(ns)) { out[ns] = 'reserved'; continue; }
    let n: any;
    try { n = await core.readNamespace({ name: ns }); } catch (e) { if (notFound(e)) { out[ns] = 'absent'; continue; } throw e; }
    if (n?.metadata?.labels?.[PROJECT_LABEL] !== projectId) { out[ns] = 'not-owned'; continue; }
    try { await core.deleteNamespace({ name: ns }); out[ns] = 'deleted'; } catch (e) { if (notFound(e)) out[ns] = 'absent'; else throw e; }
  }
  return out;
}

/** Previews created before per-project preview namespaces live in the shared `preview` namespace. */
export async function removeLegacyPreviews(projectId: string): Promise<number> {
  if (!UUID_RE.test(projectId)) return 0;
  const { apps, core, net } = kube();
  const labelSelector = `platform-project-id=${projectId}`;
  const namespace = 'preview';
  let removed = 0;
  const each = async (list: () => Promise<any>, del: (name: string) => Promise<any>) => {
    let items: any[] = [];
    try { const r = await list(); items = (r?.body || r)?.items || []; } catch (e) { if (notFound(e)) return; throw e; }
    for (const item of items) {
      if (item?.metadata?.labels?.['platform-project-id'] !== projectId) continue;
      try { await del(item.metadata.name); removed++; } catch (e) { if (!notFound(e)) throw e; }
    }
  };
  await each(() => apps.listNamespacedDeployment({ namespace, labelSelector }), (name) => apps.deleteNamespacedDeployment({ name, namespace }));
  await each(() => core.listNamespacedService({ namespace, labelSelector }), (name) => core.deleteNamespacedService({ name, namespace }));
  await each(() => net.listNamespacedIngress({ namespace, labelSelector }), (name) => net.deleteNamespacedIngress({ name, namespace }));
  return removed;
}

// ── object storage ───────────────────────────────────────────────────────────

/** Delete the project's uploaded files (objects and rows). */
export async function removeUploadedFiles(projectId: string): Promise<number> {
  const ds = await getDb();
  const { File } = await import('../entities/File');
  const { fileUploadStore } = await import('./provider-upload-store');
  const { containedUploadPath } = await import('./upload-store');
  const repo = ds.getRepository(File);
  const files = await repo.find({ where: { projectId } });
  for (const file of files) {
    if (UUID_RE.test(file.id) && UUID_RE.test(String(file.projectId))) {
      try { await (await fileUploadStore(file)).delete(`${file.projectId}/${file.id}`); } catch (e: any) {
        if (!notFound(e)) throw new Error(`could not delete stored file ${file.id}: ${e?.message || e}`);
      }
      const local = containedUploadPath(file.id);
      if (local && fs.existsSync(local)) fs.unlinkSync(local);
    }
    await repo.delete({ id: file.id });
  }
  return files.length;
}

/** Delete every session-replay object of the project. */
export async function removeReplayObjects(projectId: string): Promise<number> {
  if (!UUID_RE.test(projectId)) return 0;
  const { getReplayStore } = await import('./replay-store');
  const store = getReplayStore();
  return store ? store.deletePrefix(`replays/${projectId}/`) : 0;
}

/** Delete the project's source-build images from the in-cluster registry. */
export async function removeRegistryImages(projectId: string): Promise<number> {
  const ds = await getDb();
  const { Build } = await import('../entities/Build');
  const { registryManifest, RegistryNotFoundError, cancelBuildJob, cleanupBuildSecret } = await import('./build-runtime');
  const repo = ds.getRepository(Build);
  const builds = await repo.find({ where: { projectId } });
  let removed = 0;
  for (const build of builds) {
    if (!['succeeded', 'failed', 'cancelled'].includes(build.status)) {
      await cancelBuildJob(build);
      await repo.update(build.id, { status: 'cancelled' as any, finishedAt: new Date(), error: 'Project deleted' });
    }
    await cleanupBuildSecret(build).catch(() => {});
    if (!build.imageDigest || build.prunedAt || !process.env.BUILDS_REGISTRY) continue;
    const repository = build.imageTag.slice(0, build.imageTag.lastIndexOf(':'));
    try { await registryManifest(`${repository}@${build.imageDigest}`, 'DELETE'); removed++; } catch (e) {
      if (!(e instanceof RegistryNotFoundError)) throw e;
    }
    await repo.update(build.id, { prunedAt: new Date() });
  }
  return removed;
}

// ── platform data ────────────────────────────────────────────────────────────

/**
 * Tables holding per-project data that is removed with the project. Order matters where rows
 * reference each other (children first). Deployments, builds and audit logs are kept as history.
 */
export const PROJECT_DATA_TABLES = [
  'error_events', 'error_issues', 'error_sourcemaps',
  'replay_chunks', 'replay_sessions',
  'heatmap_click_cells', 'heatmap_click_targets', 'heatmap_scroll_depth', 'heatmap_pages',
  'usage_daily_rollups', 'usage_quotas',
  'telemetry_consents', 'telemetry_privacy_settings',
  'db_connections', 'service_registrations', 'clickup_task_links', 'project_configs',
];

const MONGO_COLLECTIONS = ['ApiMetric', 'BugReport', 'ErrorDoc', 'FeatureFlag', 'Log', 'MetricsHourly', 'MetricsRaw', 'SdkEvent'];

/**
 * Delete the project's rows from the platform database and its documents from the platform
 * MongoDB. `legacyName` is the project name when legacy SDK data keyed by name can only belong
 * to this project (no other project ever used the name); otherwise null.
 */
export async function removeProjectData(projectId: string, legacyName: string | null): Promise<Record<string, number>> {
  const ds = await getDb();
  const out: Record<string, number> = {};
  const present: string[] = (await ds.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1)`,
    [PROJECT_DATA_TABLES],
  )).map((r: any) => r.table_name);
  for (const table of PROJECT_DATA_TABLES) {
    if (!present.includes(table)) continue;
    const res: any = await ds.query(`DELETE FROM "${table}" WHERE project_id = $1`, [projectId]);
    out[table] = Array.isArray(res) && typeof res[1] === 'number' ? res[1] : 0;
  }
  const { connectMongo } = await import('../config/mongoose');
  if (await connectMongo()) {
    const ids = legacyName ? [projectId, legacyName] : [projectId];
    for (const model of MONGO_COLLECTIONS) {
      const mod = await import(`../schemas/${model}`);
      const Model = mod[`${model}Model`];
      if (!Model) continue;
      const r = await Model.deleteMany({ projectId: { $in: ids } });
      out[`mongo:${model}`] = r?.deletedCount ?? 0;
    }
  }
  return out;
}
