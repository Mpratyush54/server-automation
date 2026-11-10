/** Session replay (#40) SQL against real Postgres (opt-in, same credentials as migrations.db.test.ts). */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { gzipSync } from 'zlib';
import { ErrorTracking1798000000041 } from '../../src/migrations/1798000000041-ErrorTracking';
import { SessionReplay1799000000040 } from '../../src/migrations/1799000000040-SessionReplay';
import { parseReplayChunk, replayLimits } from '../../src/lib/replay-ingest';
import { MemoryReplayStore } from '../helpers/memory-replay-store';
import {
  deleteReplaysForSubject, getReplaySession, getReplaySnapshot, listReplaySessions, runReplayRetention, storeReplayChunk,
} from '../../src/lib/replay-sessions';

const enabled = process.env.MIGRATION_TEST_PG_HOST;
(enabled ? describe : describe.skip)('session replay real Postgres', () => {
  let db: DataSource; let admin: DataSource;
  const schema = `replay_test_${randomUUID().replace(/-/g, '')}`;
  const project = randomUUID();
  const conn = { type: 'postgres' as const, host: enabled,
    port: Number(process.env.MIGRATION_TEST_PG_PORT || 5432), username: process.env.MIGRATION_TEST_PG_USER || 'postgres',
    password: process.env.MIGRATION_TEST_PG_PASSWORD || 'postgres', database: 'postgres' };
  const limits = replayLimits({});
  const store = new MemoryReplayStore();
  const now = Date.now();
  const chunk = (sessionId: string, seq: number, extra: Record<string, unknown> = {}, t0 = now - 60_000) => {
    const body = gzipSync(Buffer.from(JSON.stringify({ v: 1, sessionId, seq, page: '/orders/42', subjectId: 'anon-12345678', events: [
      { type: 4, timestamp: t0, data: { href: 'https://app.test/orders/42', width: 800, height: 600 } },
      { type: 2, timestamp: t0 + 1, data: { node: { type: 0, childNodes: [{ type: 2, tagName: 'html', attributes: {}, childNodes: [] }] } } },
      { type: 3, timestamp: t0 + 500, data: {} },
    ], ...extra })));
    return storeReplayChunk(db, store, { projectId: project, chunk: parseReplayChunk(body, limits), body, limits });
  };

  beforeAll(async () => {
    admin = await new DataSource(conn).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({ ...conn, extra: { options: `-c search_path=${schema},public` } }).initialize();
    await db.query('CREATE TABLE projects(id uuid PRIMARY KEY)');
    await db.query('CREATE TABLE users(id uuid PRIMARY KEY)');
    await db.query(`CREATE TABLE telemetry_privacy_settings(project_id uuid PRIMARY KEY, retention_days jsonb NOT NULL DEFAULT '{}')`);
    await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
    const runner = db.createQueryRunner();
    try {
      await new ErrorTracking1798000000041().up(runner);
      await new SessionReplay1799000000040().up(runner);
      await new SessionReplay1799000000040().up(runner); // idempotent
    } finally { await runner.release(); }
    await db.query('INSERT INTO projects(id) VALUES($1)', [project]);
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
  });

  test('aggregates chunks, orders by seq, finds snapshots, links errors, retention and GDPR', async () => {
    await chunk('sess-pg-000001', 1, { errors: 1, page: '/checkout', userId: 'user-1' }, now - 30_000);
    await chunk('sess-pg-000001', 0, { userId: 'user-1' });
    expect((await chunk('sess-pg-000001', 0)).duplicate).toBe(true);
    const out = await getReplaySession(db, project, 'sess-pg-000001');
    expect(out!.session).toMatchObject({ chunk_count: 2, error_count: 1, first_page: '/orders/42', user_id: 'user-1' });
    expect(Number(out!.session.duration_ms)).toBeGreaterThanOrEqual(30_000);
    expect(out!.chunks.map((c: any) => c.seq)).toEqual([0, 1]);
    expect((await listReplaySessions(db, project, { page: 'check', hasErrors: true })).length).toBe(1);
    const snap = await getReplaySnapshot(db, store, { projectId: project, sessionId: 'latest', page: '/orders/:id', maxRawBytes: limits.maxRawBytes });
    expect(snap?.sessionId).toBe('sess-pg-000001');

    await chunk('sess-pg-old001', 0, {}, now - 9 * 86_400_000);
    expect((await runReplayRetention(db, store)).sessions).toBe(1);
    await db.query(`INSERT INTO telemetry_privacy_settings(project_id, retention_days) VALUES ($1, '{"replays": 1}')`, [project]);
    expect((await runReplayRetention(db, store, now + 2 * 86_400_000)).sessions).toBe(1);
    await chunk('sess-pg-000002', 0, { userId: 'user-2' });
    expect(await deleteReplaysForSubject(db, store, project, { userId: 'user-2' })).toEqual({ sessions: 1, objects: 1 });
    expect(await db.query('SELECT count(*)::int AS n FROM replay_chunks')).toEqual([{ n: 0 }]);
  });
});
