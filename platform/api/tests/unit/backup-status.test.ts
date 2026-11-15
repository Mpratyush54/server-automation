import { parseBackupStatus, backupMetrics, parseBackupStorage, postgresRecovery, backupOverview, isoTime } from '../../src/lib/backup-status';

const valid = { id: 'test', success: true, finishedAt: '2026-01-01T00:00:00Z', durationSeconds: 3, bytes: 123, lastSuccessTimestamp: 1767225600 };
describe('backup status', () => {
  it('exposes numeric Prometheus samples without reflecting arbitrary fields', () => {
    const s = parseBackupStatus(JSON.stringify({ ...valid, secret: 'hidden' }));
    expect(s).toEqual(valid);
    expect(backupMetrics('backup', s)).toContain('platform_backup_success{operation="backup"} 1');
    expect(backupMetrics('restore-test', { ...s, success: false })).toContain('platform_backup_success{operation="restore-test"} 0');
  });
  it.each([{ ...valid, bytes: -1 }, { ...valid, durationSeconds: '3' }, { ...valid, success: 'true' }, { ...valid, finishedAt: 'yesterday' }, null])('rejects malformed state', value => {
    expect(() => parseBackupStatus(JSON.stringify(value))).toThrow();
  });
  it('rejects metric label injection', () => { expect(() => backupMetrics('bad"', valid)).toThrow(); });
});

describe('backup storage and recovery window (#186)', () => {
  const plugin = { name: 'barman-cloud.cloudnative-pg.io', isWALArchiver: true, parameters: { barmanObjectName: 'postgresql-backup', serverName: 'postgresql-20261101t1200' } };
  const cluster = { spec: { instances: 1, plugins: [plugin] }, status: { conditions: [{ type: 'ContinuousArchiving', status: 'True' }] } };
  const store = { spec: { configuration: { s3Credentials: { secretAccessKey: { name: 'platform-backup-s3', key: 'ACCESS_SECRET_KEY' } } } },
    status: { serverRecoveryWindow: { 'postgresql-20261101t1200': { firstRecoverabilityPoint: '2026-11-01T12:05:00Z', lastSuccessfulBackupTime: '2026-11-15T03:00:10Z' } } } };

  it('reports the off-site target without credentials or unknown fields', () => {
    const s = parseBackupStorage({ mode: 'external', endpointHost: 'acct.r2.cloudflarestorage.com', bucket: 'cairn-bk', prefix: 'srv-a', region: 'auto', updatedAt: '2026-11-15T00:00:00Z', 'secret-key': 'leak' } as any);
    expect(s).toEqual({ mode: 'external', localOnly: false, target: { endpoint: 'acct.r2.cloudflarestorage.com', endpointHost: 'acct.r2.cloudflarestorage.com', bucket: 'cairn-bk', prefix: 'srv-a', region: 'auto' } });
    expect(JSON.stringify(s)).not.toContain('leak');
  });

  it('shows the endpoint as configured, scheme included', () => {
    const s = parseBackupStorage({ mode: 'external', endpoint: 'http://10.0.0.5:9000', endpointHost: '10.0.0.5:9000', bucket: 'cairn-bk' });
    expect(s.target?.endpoint).toBe('http://10.0.0.5:9000');
    // Anything but scheme://host[:port] falls back to the host.
    const bad = parseBackupStorage({ mode: 'external', endpoint: 'javascript:alert(1)', endpointHost: 'h.example', bucket: 'cairn-bk' });
    expect(bad.target?.endpoint).toBe('h.example');
    const creds = parseBackupStorage({ mode: 'external', endpoint: 'https://u:p@h.example', endpointHost: 'h.example', bucket: 'cairn-bk' });
    expect(creds.target?.endpoint).toBe('h.example');
  });

  it('treats local, missing and malformed summaries as local-only', () => {
    expect(parseBackupStorage({ mode: 'local' })).toEqual({ mode: 'local', localOnly: true, target: null });
    expect(parseBackupStorage(null)).toEqual({ mode: 'unset', localOnly: true, target: null });
    expect(parseBackupStorage({ mode: 'external', endpointHost: 'h"><script>', bucket: 'b' }).localOnly).toBe(true);
    expect(parseBackupStorage({ mode: 'external', endpointHost: 'h.example', bucket: 'cairn-bk', prefix: 'a/../b' }).localOnly).toBe(true);
  });

  it('derives archiving state, last WAL, last base backup and the recovery window', () => {
    const pg = postgresRecovery(cluster, store, { last_archived_time: new Date('2026-11-15T09:59:00Z'), last_failed_time: null });
    expect(pg).toEqual({
      engine: 'cnpg', archiving: 'ok',
      lastArchivedWalAt: '2026-11-15T09:59:00.000Z', lastFailedWalAt: null, lastBaseBackupAt: '2026-11-15T03:00:10.000Z',
      recoveryWindow: { from: '2026-11-01T12:05:00.000Z', to: '2026-11-15T09:59:00.000Z' },
    });
  });

  it('flags failing archiving from the condition or a newer failure', () => {
    const failingCond = { ...cluster, status: { conditions: [{ type: 'ContinuousArchiving', status: 'False' }] } };
    expect(postgresRecovery(failingCond, store, null).archiving).toBe('failing');
    const newerFailure = postgresRecovery(cluster, store, { last_archived_time: '2026-11-15T09:00:00Z', last_failed_time: '2026-11-15T09:30:00Z' });
    expect(newerFailure.archiving).toBe('failing');
    expect(postgresRecovery({ spec: {} }, null, null).archiving).toBe('not-configured');
    expect(postgresRecovery(null, null, null)).toEqual(expect.objectContaining({ engine: 'bitnami', archiving: 'not-configured', recoveryWindow: { from: null, to: null } }));
  });

  it('adds storage, the last full backup and localOnly on the backup item', () => {
    const status = { id: 'x', success: true, finishedAt: '2026-11-15T02:20:00Z', durationSeconds: 60, bytes: 10, lastSuccessTimestamp: 1763173200 };
    const body = backupOverview([{ operation: 'backup', status }, { operation: 'restore-test', status: null }], parseBackupStorage({ mode: 'local' }), null);
    expect(body.items[0].localOnly).toBe(true);
    expect(body.items[1]).toEqual({ operation: 'restore-test', status: null });
    expect(body.lastFullBackupAt).toBe(new Date(1763173200 * 1000).toISOString());
    expect(backupOverview([], parseBackupStorage(null), null).lastFullBackupAt).toBeNull();
  });

  it('rejects unparsable times', () => {
    expect(isoTime('yesterday')).toBeNull();
    expect(isoTime(42)).toBeNull();
    expect(isoTime('x'.repeat(100))).toBeNull();
  });
});
