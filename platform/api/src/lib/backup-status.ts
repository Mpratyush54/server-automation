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
