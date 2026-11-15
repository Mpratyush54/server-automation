export interface BackupStatus {
  id: string;
  success: boolean;
  finishedAt: string;
  durationSeconds: number;
  bytes: number;
  lastSuccessTimestamp: number;
}

export function parseBackupStatus(raw: string): BackupStatus {
  const v = JSON.parse(raw);
  if (!v || typeof v.id !== 'string' || v.id.length > 100 || typeof v.success !== 'boolean'
      || typeof v.finishedAt !== 'string' || !Number.isFinite(Date.parse(v.finishedAt))
      || ![v.durationSeconds, v.bytes, v.lastSuccessTimestamp].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    throw new Error('Invalid backup status');
  }
  return { id: v.id, success: v.success, finishedAt: v.finishedAt, durationSeconds: v.durationSeconds, bytes: v.bytes, lastSuccessTimestamp: v.lastSuccessTimestamp };
}

export function backupMetrics(operation: string, s: BackupStatus): string {
  if (!['backup', 'restore-test'].includes(operation)) throw new Error('Invalid backup operation');
  const label = `{operation="${operation}"}`;
  return [
    `platform_backup_success${label} ${s.success ? 1 : 0}`,
    `platform_backup_completed_timestamp_seconds${label} ${Math.floor(Date.parse(s.finishedAt) / 1000)}`,
    `platform_backup_last_success_timestamp_seconds${label} ${s.lastSuccessTimestamp}`,
    `platform_backup_size_bytes${label} ${s.bytes}`,
    `platform_backup_duration_seconds${label} ${s.durationSeconds}`,
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Where backups go and how far back PostgreSQL can be recovered (#186).
// Inputs come from platformctl's ConfigMap and the CloudNativePG objects;
// only whitelisted, validated fields are returned, never credentials.

export type BackupMode = 'external' | 'local' | 'unset';

export interface BackupTarget { endpointHost: string; bucket: string; prefix: string; region: string }

export interface BackupStorage {
  mode: BackupMode;
  /** True unless an off-site target is configured: backups live only on this server. */
  localOnly: boolean;
  target: BackupTarget | null;
}

export type ArchiveState = 'ok' | 'failing' | 'not-configured' | 'unknown';

export interface PostgresRecovery {
  engine: 'cnpg' | 'bitnami';
  archiving: ArchiveState;
  lastArchivedWalAt: string | null;
  lastFailedWalAt: string | null;
  lastBaseBackupAt: string | null;
  /** Earliest and latest point PostgreSQL can be recovered to. */
  recoveryWindow: { from: string | null; to: string | null };
}

export interface ArchiverRow { last_archived_time?: unknown; last_failed_time?: unknown }

const HOST_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,255}$/;
const REGION_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SERVER_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;

/** A timestamp as ISO 8601, or null for anything unparsable. */
export function isoTime(v: unknown): string | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v !== 'string' || v.length > 64) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** platform/platform-backup-target ConfigMap data (missing: install from before #186). */
export function parseBackupStorage(data: Record<string, string> | null | undefined): BackupStorage {
  const mode = data?.mode;
  if (mode === 'external') {
    const endpointHost = data?.endpointHost || '';
    const bucket = data?.bucket || '';
    const prefix = data?.prefix || '';
    const region = data?.region || '';
    if (HOST_RE.test(endpointHost) && BUCKET_RE.test(bucket) && (prefix === '' || (PREFIX_RE.test(prefix) && !prefix.includes('..'))) && (region === '' || REGION_RE.test(region))) {
      return { mode: 'external', localOnly: false, target: { endpointHost, bucket, prefix, region } };
    }
    return { mode: 'unset', localOnly: true, target: null };
  }
  return { mode: mode === 'local' ? 'local' : 'unset', localOnly: true, target: null };
}

function pluginServerName(cluster: any): string | null {
  const plugins = Array.isArray(cluster?.spec?.plugins) ? cluster.spec.plugins : [];
  const p = plugins.find((x: any) => x?.name === 'barman-cloud.cloudnative-pg.io' && x?.isWALArchiver);
  if (!p) return null;
  const n = p.parameters?.serverName;
  return typeof n === 'string' && SERVER_RE.test(n) ? n : 'postgresql';
}

/**
 * Recovery state from the CloudNativePG Cluster, the Barman Cloud ObjectStore
 * and pg_stat_archiver. cluster === null means PostgreSQL is not on CNPG.
 */
export function postgresRecovery(cluster: any | null, store: any | null, archiver: ArchiverRow | null): PostgresRecovery {
  if (!cluster) {
    return { engine: 'bitnami', archiving: 'not-configured', lastArchivedWalAt: null, lastFailedWalAt: null, lastBaseBackupAt: null, recoveryWindow: { from: null, to: null } };
  }
  const lastArchivedWalAt = isoTime(archiver?.last_archived_time);
  const lastFailedWalAt = isoTime(archiver?.last_failed_time);
  const server = pluginServerName(cluster);
  const inTree = !!cluster?.spec?.backup?.barmanObjectStore;
  let archiving: ArchiveState = server || inTree ? 'unknown' : 'not-configured';
  const conditions = Array.isArray(cluster?.status?.conditions) ? cluster.status.conditions : [];
  const cond = conditions.find((c: any) => c?.type === 'ContinuousArchiving');
  if ((server || inTree) && cond) archiving = cond.status === 'True' ? 'ok' : 'failing';
  if (archiving === 'ok' && lastFailedWalAt && (!lastArchivedWalAt || Date.parse(lastFailedWalAt) > Date.parse(lastArchivedWalAt))) archiving = 'failing';
  let first: string | null = null;
  let lastBackup: string | null = null;
  if (server) {
    const w = store?.status?.serverRecoveryWindow?.[server];
    first = isoTime(w?.firstRecoverabilityPoint);
    lastBackup = isoTime(w?.lastSuccessfulBackupTime);
  } else if (inTree) {
    first = isoTime(cluster?.status?.firstRecoverabilityPoint);
    lastBackup = isoTime(cluster?.status?.lastSuccessfulBackup);
  }
  return {
    engine: 'cnpg', archiving, lastArchivedWalAt, lastFailedWalAt, lastBaseBackupAt: lastBackup,
    recoveryWindow: { from: first, to: first ? later(lastArchivedWalAt, lastBackup) : null },
  };
}

export interface BackupItem { operation: string; status: BackupStatus | null; localOnly?: boolean }

export interface BackupOverview {
  items: BackupItem[];
  storage: BackupStorage;
  postgres: PostgresRecovery | null;
  lastFullBackupAt: string | null;
}

/** The GET /settings/backups body. The backup item repeats localOnly for list consumers. */
export function backupOverview(items: BackupItem[], storage: BackupStorage, postgres: PostgresRecovery | null): BackupOverview {
  const backup = items.find(i => i.operation === 'backup')?.status;
  const lastFullBackupAt = backup && backup.lastSuccessTimestamp > 0 ? new Date(backup.lastSuccessTimestamp * 1000).toISOString() : null;
  return {
    items: items.map(i => (i.operation === 'backup' ? { ...i, localOnly: storage.localOnly } : i)),
    storage, postgres, lastFullBackupAt,
  };
}
