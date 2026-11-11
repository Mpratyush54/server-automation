/** Error-tracking retention: per-project errors retention, bounded batches, empty issues. */
jest.mock('../../../src/config/database', () => ({ getDb: async () => { throw new Error('use the injected db'); } }));

import { runErrorRetention, deleteExpiredEvents } from '../../../src/lib/error-retention';

const NOW = new Date('2026-06-01T00:00:00Z');
const DAY = 86_400_000;
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P2 = 'aaaaaaaa-0000-4000-8000-000000000002';

type Call = { sql: string; params: any[] };
function fakeDb(handler: (sql: string, params: any[]) => any) {
  const calls: Call[] = [];
  return {
    calls,
    db: { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return handler(sql, params); } },
  };
}

describe('error retention', () => {
  it('applies per-project overrides, the 90-day default to the rest, and removes empty issues', async () => {
    const { db, calls } = fakeDb((sql) => {
      if (sql.includes('telemetry_privacy_settings')) return [{ project_id: P1, days: '7' }, { project_id: P2, days: '365' }];
      if (sql.includes('DELETE FROM error_events')) return [{ n: 3 }];
      if (sql.includes('DELETE FROM error_issues')) return [{ n: 1 }];
      return [];
    });
    const res = await runErrorRetention(NOW, db as any, { batchSize: 1000, maxBatches: 5 });
    // P1, P2 and the default scope: one events batch + one issues batch each.
    expect(res).toEqual({ events: 9, issues: 3 });
    const events = calls.filter((c) => c.sql.includes('DELETE FROM error_events'));
    expect(events.map((c) => c.params[0])).toEqual([P1, P2, [P1, P2]]);
    expect(events[0].params[1]).toEqual(new Date(NOW.getTime() - 7 * DAY));
    expect(events[1].params[1]).toEqual(new Date(NOW.getTime() - 365 * DAY));
    expect(events[2].params[1]).toEqual(new Date(NOW.getTime() - 90 * DAY));
    expect(events[2].sql).toContain('NOT (project_id = ANY($1::uuid[]))');
    const issues = calls.filter((c) => c.sql.includes('DELETE FROM error_issues'));
    // The delete re-checks last_seen and emptiness on the row itself (concurrent ingest).
    expect(issues[0].sql).toMatch(/WHERE x\.id = d\.id AND x\.last_seen < \$2 AND NOT EXISTS/);
  });

  it('works in bounded batches and stops at maxBatches', async () => {
    let calls = 0;
    const db = { query: async () => { calls++; return [{ n: 100 }]; } };
    expect(await deleteExpiredEvents(db as any, { sql: 'project_id = $1', params: [P1] }, NOW, 100, 4)).toBe(400);
    expect(calls).toBe(4);
    let n = 0;
    const db2 = { query: async () => [{ n: [100, 100, 7][n++] }] };
    expect(await deleteExpiredEvents(db2 as any, { sql: 'project_id = $1', params: [P1] }, NOW, 100, 10)).toBe(207);
  });

  it('without overrides only the default scope runs', async () => {
    const { db, calls } = fakeDb((sql) => (sql.includes('telemetry_privacy_settings') ? [] : [{ n: 0 }]));
    expect(await runErrorRetention(NOW, db as any, { batchSize: 10, maxBatches: 1 })).toEqual({ events: 0, issues: 0 });
    expect(calls.filter((c) => c.sql.includes('DELETE')).map((c) => c.params[0])).toEqual([[], []]);
  });
});
