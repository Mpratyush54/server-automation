/** Real Postgres concurrency gate, using the same opt-in credentials as migrations.db.test.ts. */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import * as database from '../../src/config/database';
import { ErrorTracking1798000000041 } from '../../src/migrations/1798000000041-ErrorTracking';
import { processErrorEvent } from '../../src/lib/error-tracking';
import { setAlertEventTestHook } from '../../src/lib/alert-events';

const enabled = process.env.MIGRATION_TEST_PG_HOST;
(enabled ? describe : describe.skip)('error tracking real Postgres', () => {
  let db: DataSource; let admin: DataSource;
  const schema = `error_test_${randomUUID().replace(/-/g, '')}`;
  const project = randomUUID();
  const conn = { type: 'postgres' as const, host: enabled,
    port: Number(process.env.MIGRATION_TEST_PG_PORT || 5432), username: process.env.MIGRATION_TEST_PG_USER || 'postgres',
    password: process.env.MIGRATION_TEST_PG_PASSWORD || 'postgres', database: 'postgres' };
  beforeAll(async () => {
    admin = await new DataSource(conn).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({ ...conn, extra: { options: `-c search_path=${schema},public` } }).initialize();
    await db.query('CREATE TABLE projects(id uuid PRIMARY KEY)');
    await db.query('CREATE TABLE users(id uuid PRIMARY KEY)');
    // uuid-ossp is installed by the baseline migration in production.
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    const runner = db.createQueryRunner();
    try { await new ErrorTracking1798000000041().up(runner); await new ErrorTracking1798000000041().up(runner); }
    finally { await runner.release(); }
    await db.query('INSERT INTO projects(id) VALUES($1)', [project]);
    jest.spyOn(database, 'getDb').mockResolvedValue(db);
  });
  afterAll(async () => {
    jest.restoreAllMocks(); setAlertEventTestHook(null);
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
  });
  test('100 concurrent occurrences, retries and regression are atomic across workers', async () => {
    const alerts: any[] = []; setAlertEventTestHook(e => alerts.push(e));
    const make = (release = '1.0.0') => ({ projectId: project, event: { eventId: randomUUID(), type: 'Error', message: 'test',
      frames: [{ file: '/app.js', line: 1, column: 0 }], release, environment: 'test' } });
    const events = Array.from({ length: 100 }, () => make());
    await Promise.all(events.map(processErrorEvent));
    await Promise.all(events.map(processErrorEvent));
    let issues = await db.query('SELECT * FROM error_issues');
    expect(issues).toHaveLength(1); expect(Number(issues[0].count)).toBe(100);
    expect(issues[0].release_counts).toEqual({ '1.0.0': 100 }); expect(alerts).toHaveLength(1);
    await db.query("UPDATE error_issues SET status='resolved',resolved_release='1.0.0'");
    await processErrorEvent(make('0.9.0'));
    expect((await db.query('SELECT status FROM error_issues'))[0].status).toBe('resolved');
    await Promise.all(Array.from({ length: 10 }, () => processErrorEvent(make('1.1.0'))));
    issues = await db.query('SELECT * FROM error_issues');
    expect(issues[0]).toMatchObject({ status: 'open', regression: true, latest_release: '1.1.0' });
    expect(issues[0].release_counts['1.1.0']).toBe(10); expect(alerts).toHaveLength(2);
  }, 60000);
});
