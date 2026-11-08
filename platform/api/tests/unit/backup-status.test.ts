import { parseBackupStatus, backupMetrics } from '../../src/lib/backup-status';

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
