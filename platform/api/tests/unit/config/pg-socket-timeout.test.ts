import { EventEmitter } from 'events';
import { armPostgresSocketTimeouts } from '../../../src/config/database';

/** Fake socket recording setTimeout/destroy. */
class FakeStream extends EventEmitter {
  timeout = 0;
  destroyed?: Error;
  setTimeout(ms: number) { this.timeout = ms; return this; }
  destroy(err?: Error) { this.destroyed = err || new Error('destroyed'); return this; }
}

function fakeDs(existing: FakeStream[]) {
  const pool = new EventEmitter() as EventEmitter & { _clients: any[] };
  pool._clients = existing.map((stream) => ({ connection: { stream } }));
  return { ds: { driver: { master: pool } } as any, pool };
}

describe('armPostgresSocketTimeouts', () => {
  it('arms existing and new pooled connections and destroys a silent socket', () => {
    const old = new FakeStream();
    const { ds, pool } = fakeDs([old]);
    armPostgresSocketTimeouts(ds, 1234);
    expect(old.timeout).toBe(1234);
    const fresh = new FakeStream();
    pool.emit('connect', { connection: { stream: fresh } });
    expect(fresh.timeout).toBe(1234);
    fresh.emit('timeout');
    expect(fresh.destroyed?.message).toMatch(/silent for 1234 ms/);
    expect(old.destroyed).toBeUndefined();
  });

  it('arms a socket once and does nothing without a pool or with 0', () => {
    const s = new FakeStream();
    const { ds, pool } = fakeDs([s]);
    armPostgresSocketTimeouts(ds, 500);
    armPostgresSocketTimeouts(ds, 500);
    expect(s.listenerCount('timeout')).toBe(1);
    expect(() => armPostgresSocketTimeouts({ driver: {} } as any, 500)).not.toThrow();
    const other = new FakeStream();
    armPostgresSocketTimeouts(fakeDs([other]).ds, 0);
    expect(other.timeout).toBe(0);
    expect(pool.listenerCount('connect')).toBe(1);
  });
});
