import crypto from 'crypto';

/**
 * Cron schedules of browser-check CronJobs (#42). The CronJobs run in UTC
 * (`timeZone: Etc/UTC`), so the next run shown by the API is computed here from the
 * same schedule instead of the scheduler's next_run_at (unused for browser checks).
 */

/** Cron schedule for a browser interval, offset by a per-check minute so jobs spread out. */
export function cronSchedule(intervalSeconds: number, checkId: string): string {
  const minutes = Math.max(5, Math.round(intervalSeconds / 60));
  const hash = crypto.createHash('sha256').update(checkId).digest();
  if (minutes < 60) {
    const offset = hash[0] % minutes;
    const list: number[] = [];
    for (let m = offset; m < 60; m += minutes) list.push(m);
    return `${list.join(',')} * * * *`;
  }
  const hours = Math.max(1, Math.round(minutes / 60));
  const minute = hash[0] % 60;
  if (hours >= 24) return `${minute} ${hash[1] % 24} * * *`;
  return `${minute} ${hash[1] % hours}-23/${hours} * * *`;
}

/** Values allowed by one cron field (`*`, `a`, `a-b`, `*\/s`, `a-b/s`, comma lists). */
function cronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return null;
    const lo = m[1] === '*' ? min : Number(m[2]);
    const hi = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : (m[4] ? max : lo);
    const step = m[4] ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Next time (UTC) strictly after `after` that matches a 5-field cron schedule; null if none within 8 days. */
export function nextCronRun(schedule: string, after: Date): Date | null {
  const f = schedule.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = cronField(f[0], 0, 59);
  const hour = cronField(f[1], 0, 23);
  const dom = cronField(f[2], 1, 31);
  const month = cronField(f[3], 1, 12);
  const dow = cronField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  const t = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++, t.setTime(t.getTime() + 60_000)) {
    const wd = t.getUTCDay();
    if (minute.has(t.getUTCMinutes()) && hour.has(t.getUTCHours()) && dom.has(t.getUTCDate())
      && month.has(t.getUTCMonth() + 1) && (dow.has(wd) || (wd === 0 && dow.has(7)))) {
      return new Date(t.getTime());
    }
  }
  return null;
}

/** Next scheduled run of a browser check, or null when it is disabled. */
export function browserNextRun(check: { id: string; intervalSeconds: number; enabled: boolean }, now = new Date()): Date | null {
  return check.enabled ? nextCronRun(cronSchedule(check.intervalSeconds, check.id), now) : null;
}
