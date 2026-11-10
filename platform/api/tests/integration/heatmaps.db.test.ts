/** Real Postgres gate for heatmap aggregation + retention (opt-in, like migrations.db.test.ts). */
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { Heatmaps1799000000400 } from '../../src/migrations/1799000000400-Heatmaps';
import {
  aggregateHeatmapEvents,
  listHeatmapPages,
  persistHeatmapAggregates,
  pruneHeatmaps,
  queryClickHeatmap,
  queryScrollHeatmap,
  HeatmapEvent,
} from '../../src/lib/heatmaps';

const enabled = process.env.MIGRATION_TEST_PG_HOST;
(enabled ? describe : describe.skip)('heatmaps real Postgres', () => {
  let db: DataSource; let admin: DataSource;
  const schema = `heatmap_test_${randomUUID().replace(/-/g, '')}`;
  const project = randomUUID();
  const other = randomUUID();
  const conn = { type: 'postgres' as const, host: enabled,
    port: Number(process.env.MIGRATION_TEST_PG_PORT || 5432), username: process.env.MIGRATION_TEST_PG_USER || 'postgres',
    password: process.env.MIGRATION_TEST_PG_PASSWORD || 'postgres', database: 'postgres' };
  beforeAll(async () => {
    admin = await new DataSource(conn).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    db = await new DataSource({ ...conn, extra: { options: `-c search_path=${schema},public` } }).initialize();
    await db.query('CREATE TABLE projects(id uuid PRIMARY KEY)');
    await db.query(`CREATE TABLE telemetry_privacy_settings(project_id uuid PRIMARY KEY, retention_days jsonb NOT NULL DEFAULT '{}')`);
    const runner = db.createQueryRunner();
    try { await new Heatmaps1799000000400().up(runner); await new Heatmaps1799000000400().up(runner); } // idempotent
    finally { await runner.release(); }
    await db.query('INSERT INTO projects(id) VALUES($1),($2)', [project, other]);
  });
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.destroy(); }
  });

  test('concurrent batches add up exactly; queries are project-scoped; retention prunes per project', async () => {
    const batch: HeatmapEvent[] = [
      { type: 'click', page: '/a', viewport: 'desktop', x: 0.5, y: 0.5, selector: 'button#go' },
      { type: 'click', page: '/a', viewport: 'mobile', x: 0.1, y: 0.9, selector: null },
      { type: 'scroll', page: '/a', viewport: 'desktop', depth: 60 },
    ];
    await Promise.all(Array.from({ length: 50 }, () => persistHeatmapAggregates(db, project, aggregateHeatmapEvents(batch), { day: '2026-11-10' })));
    await persistHeatmapAggregates(db, other, aggregateHeatmapEvents(batch), { day: '2026-11-10' });
    const q = { projectId: project, page: '/a', from: '2026-11-01', to: '2026-11-10' };
    const all = await queryClickHeatmap(db, { ...q, viewport: null });
    expect(all.total).toBe(100);
    expect(all.cells).toEqual(expect.arrayContaining([[50, 50, 50], [10, 90, 50]]));
    expect(all.topTargets).toEqual([{ selector: 'button#go', count: 50 }]);
    expect((await queryClickHeatmap(db, { ...q, viewport: 'mobile' })).total).toBe(50);
    const s = await queryScrollHeatmap(db, { ...q, viewport: 'desktop' });
    expect(s.views).toBe(50);
    expect(s.reach.find((r) => r.depth === 60)!.pct).toBe(100);
    expect(s.reach.find((r) => r.depth === 65)!.pct).toBe(0);
    expect(await listHeatmapPages(db, { projectId: project, from: q.from, to: q.to, viewport: null })).toEqual([{ page: '/a', clicks: 100, views: 50 }]);

    // Old rows: project keeps 1 day (custom #47 retention), other uses the default (90).
    await persistHeatmapAggregates(db, project, aggregateHeatmapEvents(batch), { day: '2020-01-01' });
    await persistHeatmapAggregates(db, other, aggregateHeatmapEvents(batch), { day: '2026-11-08' });
    await db.query(`INSERT INTO telemetry_privacy_settings(project_id, retention_days) VALUES ($1, '{"heatmaps": 1}')`, [project]);
    await db.query(`UPDATE heatmap_click_cells SET day = CURRENT_DATE - 5 WHERE project_id = $1 AND day = '2026-11-10'`, [project]);
    const pruned = await pruneHeatmaps(db, 90);
    expect(pruned.heatmap_click_cells).toBeGreaterThan(0);
    const left = await db.query('SELECT project_id, count(*)::int AS n FROM heatmap_click_cells GROUP BY project_id');
    const byProject = Object.fromEntries(left.map((r: any) => [r.project_id, r.n]));
    expect(byProject[project]).toBeUndefined();
    expect(byProject[other]).toBeGreaterThan(0);
  }, 60000);
});
