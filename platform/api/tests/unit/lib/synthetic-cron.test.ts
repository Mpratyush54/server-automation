import { browserNextRun, cronSchedule, nextCronRun } from '../../../src/lib/synthetic-cron';
import { renderBrowserCronJob } from '../../../src/lib/synthetic-k8s';
import { publicCheck } from '../../../src/lib/synthetic-checks';

const ID = 'cccccccc-0000-4000-8000-000000000001';
const at = (iso: string) => new Date(iso);

describe('browser check next run (cron, UTC)', () => {
  it('minute lists within the hour', () => {
    expect(nextCronRun('7,22,37,52 * * * *', at('2026-11-11T10:23:30Z'))).toEqual(at('2026-11-11T10:37:00Z'));
    expect(nextCronRun('7,22,37,52 * * * *', at('2026-11-11T10:52:00Z'))).toEqual(at('2026-11-11T11:07:00Z'));
  });

  it('hour steps and daily schedules roll over days', () => {
    expect(nextCronRun('15 1-23/6 * * *', at('2026-11-11T19:20:00Z'))).toEqual(at('2026-11-12T01:15:00Z'));
    expect(nextCronRun('15 1-23/6 * * *', at('2026-11-11T06:00:00Z'))).toEqual(at('2026-11-11T07:15:00Z'));
    expect(nextCronRun('40 3 * * *', at('2026-12-31T03:40:00Z'))).toEqual(at('2027-01-01T03:40:00Z'));
  });

  it('rejects malformed schedules', () => {
    for (const s of ['', '* * * *', '61 * * * *', 'x * * * *', '5 24 * * *']) expect(nextCronRun(s, new Date())).toBeNull();
  });

  it('every generated schedule yields a run within one interval', () => {
    const now = at('2026-11-11T10:00:30Z');
    for (const interval of [300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400]) {
      const next = nextCronRun(cronSchedule(interval, ID), now);
      expect(next).not.toBeNull();
      expect(next!.getTime() - now.getTime()).toBeGreaterThan(0);
      expect(next!.getTime() - now.getTime()).toBeLessThanOrEqual(interval * 1000);
    }
  });

  it('the CronJob runs in UTC so the computed time matches', () => {
    const cj = renderBrowserCronJob({ id: ID, projectId: 'p', intervalSeconds: 900, timeoutMs: 60_000, enabled: true }, { image: 'img', apiUrl: 'http://api' });
    expect(cj.spec.timeZone).toBe('Etc/UTC');
    expect(cj.spec.schedule).toBe(cronSchedule(900, ID));
  });

  it('API view: browser checks show the CronJob next run (null when disabled); others keep next_run_at', () => {
    const now = at('2026-11-11T10:00:30Z');
    const base: any = { id: ID, projectId: 'p', type: 'browser', intervalSeconds: 900, enabled: true, nextRunAt: at('2020-01-01T00:00:00Z'), secretsEncrypted: null, alertPolicy: {}, locations: [] };
    expect(publicCheck(base, now).nextRunAt).toEqual(browserNextRun(base, now));
    expect(publicCheck(base, now).nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    expect(publicCheck({ ...base, enabled: false }, now).nextRunAt).toBeNull();
    const http = { ...base, type: 'http', nextRunAt: at('2026-11-11T10:01:00Z') };
    expect(publicCheck(http, now).nextRunAt).toEqual(at('2026-11-11T10:01:00Z'));
  });
});
