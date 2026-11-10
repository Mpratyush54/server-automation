import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Heatmaps (Phase 4 wave B2): aggregated click and scroll-depth counts per project, page,
 * viewport bucket and UTC day. Only aggregates are stored — no user, session, IP or raw
 * per-click trail — so these rows are anonymous (GDPR subject delete has nothing to remove;
 * project delete cascades). Retention: #47 per-type `heatmaps` days, pruned by the leader.
 * Idempotent (IF NOT EXISTS everywhere).
 */
export class Heatmaps1799000000400 implements MigrationInterface {
  name = 'Heatmaps1799000000400';

  async up(q: QueryRunner): Promise<void> {
    // Known pages per project (bounds page cardinality; last_day drives retention).
    await q.query(`CREATE TABLE IF NOT EXISTS heatmap_pages (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      page varchar(512) NOT NULL,
      first_day date NOT NULL DEFAULT CURRENT_DATE,
      last_day date NOT NULL DEFAULT CURRENT_DATE,
      PRIMARY KEY (project_id, page))`);
    // Click counts per grid cell (x/y normalised to the document, 100x100 grid).
    await q.query(`CREATE TABLE IF NOT EXISTS heatmap_click_cells (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      day date NOT NULL,
      page varchar(512) NOT NULL,
      viewport varchar(8) NOT NULL,
      cell_x smallint NOT NULL,
      cell_y smallint NOT NULL,
      count bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, page, viewport, day, cell_x, cell_y))`);
    // Click counts per element selector (never element text).
    await q.query(`CREATE TABLE IF NOT EXISTS heatmap_click_targets (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      day date NOT NULL,
      page varchar(512) NOT NULL,
      viewport varchar(8) NOT NULL,
      selector varchar(256) NOT NULL,
      count bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, page, viewport, day, selector))`);
    // Scroll-depth histogram: page views whose max depth fell in [depth, depth+5) percent.
    await q.query(`CREATE TABLE IF NOT EXISTS heatmap_scroll_depth (
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      day date NOT NULL,
      page varchar(512) NOT NULL,
      viewport varchar(8) NOT NULL,
      depth smallint NOT NULL,
      count bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, page, viewport, day, depth))`);
    // Retention deletes by (project, day).
    await q.query('CREATE INDEX IF NOT EXISTS heatmap_click_cells_day ON heatmap_click_cells (project_id, day)');
    await q.query('CREATE INDEX IF NOT EXISTS heatmap_click_targets_day ON heatmap_click_targets (project_id, day)');
    await q.query('CREATE INDEX IF NOT EXISTS heatmap_scroll_depth_day ON heatmap_scroll_depth (project_id, day)');
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE IF EXISTS heatmap_scroll_depth');
    await q.query('DROP TABLE IF EXISTS heatmap_click_targets');
    await q.query('DROP TABLE IF EXISTS heatmap_click_cells');
    await q.query('DROP TABLE IF EXISTS heatmap_pages');
  }
}
