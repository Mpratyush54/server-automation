/** Alert history retention: finished deliveries (30 d) and resolved incidents (180 d). */
jest.mock('../../../src/config/database', () => ({ getDb: async () => { throw new Error('use the injected db'); } }));

import { pruneAlertHistory } from '../../../src/lib/alerting-retention';

const NOW = new Date('2026-06-01T00:00:00Z');
const DAY = 86_400_000;

type Call = { sql: string; params: any[] };
function fakeDb(handler: (sql: string, params: any[]) => any) {
  const calls: Call[] = [];
  return {
    calls,
    db: { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return handler(sql, params); } },
  };
}

describe('alert history retention', () => {
  it('prunes finished deliveries after 30 days and resolved incidents after 180 days', async () => {
    const { db, calls } = fakeDb((sql) => [{ n: sql.includes('alert_incidents') ? 2 : 5 }]);
    expect(await pruneAlertHistory(NOW, db as any, { deliveryRetentionDays: 30, incidentRetentionDays: 180 })).toEqual({ deliveries: 5, incidents: 2 });
    const [del, inc] = calls;
    expect(del.sql).toContain("status <> 'pending'");
    expect(del.params[0]).toEqual(new Date(NOW.getTime() - 30 * DAY));
    expect(inc.sql).toContain("status = 'resolved'");
    expect(inc.sql).toContain('DELETE FROM alert_deliveries a USING doomed d WHERE a.incident_id = d.id');
    expect(inc.params[0]).toEqual(new Date(NOW.getTime() - 180 * DAY));
  });

  it('env-configurable', () => {
    jest.isolateModules(() => {
      process.env.ALERTING_DELIVERY_RETENTION_DAYS = '7';
      process.env.ALERTING_INCIDENT_RETENTION_DAYS = '365';
      try {
        const { alertingSettings } = require('../../../src/lib/alerting-config');
        expect(alertingSettings()).toMatchObject({ deliveryRetentionDays: 7, incidentRetentionDays: 365, deliveryConcurrency: 4 });
      } finally {
        delete process.env.ALERTING_DELIVERY_RETENTION_DAYS;
        delete process.env.ALERTING_INCIDENT_RETENTION_DAYS;
      }
    });
  });
});
