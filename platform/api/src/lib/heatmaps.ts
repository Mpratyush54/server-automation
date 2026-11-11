/**
 * Heatmaps (Phase 4 wave B2): validation, aggregation, storage, queries and retention.
 *
 * Browsers send batches of click / scroll events (`POST /api/sdk/heatmap/events`). Each batch
 * is validated, folded into per (page, viewport bucket, grid cell | selector | depth bucket)
 * counts and upserted into Postgres with `count = count + n`. No raw events, user ids, session
 * ids or IPs are stored: the tables hold anonymous aggregates only, so a GDPR subject delete
 * has nothing to remove (documented in docs/guides/heatmaps.md).
 */
import type { DataSource } from 'typeorm';
import { DEFAULT_RETENTION_DAYS } from '../entities/TelemetryPrivacySettings';

/** Click grid resolution: x and y (normalised to the document) map to 100 x 100 cells. */
export const HEATMAP_GRID = 100;
/** Scroll-depth histogram bucket width in percent (buckets 0, 5, ..., 100). */
export const SCROLL_BUCKET = 5;
export const VIEWPORTS = ['mobile', 'tablet', 'desktop'] as const;
export type ViewportBucket = (typeof VIEWPORTS)[number];

export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_PAGES_PER_BATCH = 20;
export const MAX_PAGE_LENGTH = 512;
export const MAX_SELECTOR_LENGTH = 256;
/** Max query range in days. */
export const MAX_RANGE_DAYS = 366;

export function maxPagesPerProject(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HEATMAP_MAX_PAGES);
  return Number.isFinite(n) && n >= 1 ? Math.min(100_000, Math.floor(n)) : 1000;
}

/** Same breakpoints as the SDK (`rum-heatmap.ts`). */
export function viewportBucket(width: number): ViewportBucket {
  if (!(width > 0) || width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

export function isViewport(v: unknown): v is ViewportBucket {
  return typeof v === 'string' && (VIEWPORTS as readonly string[]).includes(v);
}

const DYNAMIC_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^[A-Za-z0-9_-]{24,}$/,
];
const SEGMENT_OK = /^[A-Za-z0-9._~:@!$&'()*+,;=-]+$/;

/**
 * Normalise a page path exactly like RUM view names (`normalizeRouteName` in the browser
 * SDKs): drop origin, query and fragment; numeric / uuid / hex / opaque-token segments become
 * `:id`, e-mail-like segments `:email`. Re-applied server-side so a client cannot create
 * high-cardinality or PII-bearing page keys. Returns null when the value is not a path.
 */
export function normalizeHeatmapPage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let path = raw.trim();
  if (!path || path.length > 2048) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/)[0] || '/';
  if (!path.startsWith('/')) return null;
  const segments = path.split('/').filter(Boolean).slice(0, 32).map((seg) => {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    if (decoded.includes('@')) return ':email';
    if (DYNAMIC_SEGMENT.some((re) => re.test(decoded))) return ':id';
    return SEGMENT_OK.test(seg) ? seg : ':id';
  });
  const out = '/' + segments.join('/');
  return out.length > MAX_PAGE_LENGTH ? out.slice(0, MAX_PAGE_LENGTH) : out;
}

const SELECTOR_OK = /^[A-Za-z0-9_\-#.:>()[\]="' ]+$/;

/** Element selectors (from the SDK's cssSelector: tag/id/class/data-rum-name, never text). */
export function sanitizeSelector(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s || s.length > MAX_SELECTOR_LENGTH || !SELECTOR_OK.test(s)) return null;
  if (/@/.test(s)) return null;
  return s;
}

export type HeatmapEvent =
  | { type: 'click'; page: string; viewport: ViewportBucket; x: number; y: number; selector: string | null }
  | { type: 'scroll'; page: string; viewport: ViewportBucket; depth: number };

export interface ValidBatch {
  ok: true;
  events: HeatmapEvent[];
  /** Events that failed validation (dropped, not an error). */
  dropped: number;
  subjectId?: string;
  sessionId?: string;
}

function unit(v: unknown): number | null {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1.01) return null;
  return Math.min(1, n);
}

/**
 * Validate a batch body:
 * `{ subjectId?, sessionId?, events: [{ type:'click', page, viewport|viewportWidth, x, y, selector? },
 *   { type:'scroll', page, viewport|viewportWidth, depth }] }`.
 * x/y are fractions (0..1) of the document width/height; depth is the max percent (0..100)
 * of the document seen during one page view. Bad events are dropped individually; a bad
 * envelope is a 400.
 */
export function validateHeatmapBatch(body: unknown): ValidBatch | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'JSON object body required' };
  const src = body as Record<string, unknown>;
  if (!Array.isArray(src.events)) return { ok: false, error: 'events must be an array' };
  if (src.events.length === 0) return { ok: false, error: 'events must not be empty' };
  if (src.events.length > MAX_EVENTS_PER_BATCH) return { ok: false, error: `at most ${MAX_EVENTS_PER_BATCH} events per batch` };
  const events: HeatmapEvent[] = [];
  const pages = new Set<string>();
  let dropped = 0;
  for (const raw of src.events) {
    if (!raw || typeof raw !== 'object') { dropped++; continue; }
    const e = raw as Record<string, unknown>;
    const page = normalizeHeatmapPage(e.page);
    let viewport: ViewportBucket | null = isViewport(e.viewport) ? e.viewport : null;
    if (!viewport && typeof e.viewportWidth === 'number' && Number.isFinite(e.viewportWidth)) viewport = viewportBucket(e.viewportWidth);
    if (!page || !viewport) { dropped++; continue; }
    if (!pages.has(page) && pages.size >= MAX_PAGES_PER_BATCH) { dropped++; continue; }
    if (e.type === 'click') {
      const x = unit(e.x);
      const y = unit(e.y);
      if (x === null || y === null) { dropped++; continue; }
      events.push({ type: 'click', page, viewport, x, y, selector: sanitizeSelector(e.selector) });
    } else if (e.type === 'scroll') {
      const d = typeof e.depth === 'number' ? e.depth : NaN;
      if (!Number.isFinite(d) || d < 0 || d > 100) { dropped++; continue; }
      events.push({ type: 'scroll', page, viewport, depth: d });
    } else {
      dropped++;
      continue;
    }
    pages.add(page);
  }
  const out: ValidBatch = { ok: true, events, dropped };
  if (typeof src.subjectId === 'string' && src.subjectId) out.subjectId = src.subjectId.slice(0, 128);
  if (typeof src.sessionId === 'string' && src.sessionId) out.sessionId = src.sessionId.slice(0, 128);
  return out;
}

export function cellIndex(fraction: number): number {
  return Math.max(0, Math.min(HEATMAP_GRID - 1, Math.floor(fraction * HEATMAP_GRID)));
}

export function depthBucket(depth: number): number {
  return Math.max(0, Math.min(100, Math.floor(depth / SCROLL_BUCKET) * SCROLL_BUCKET));
}

export interface HeatmapAggregates {
  pages: string[];
  clicks: Array<{ page: string; viewport: string; x: number; y: number; count: number }>;
  targets: Array<{ page: string; viewport: string; selector: string; count: number }>;
  scrolls: Array<{ page: string; viewport: string; depth: number; count: number }>;
}

/** Fold events into aggregate rows (sorted by key so concurrent upserts lock in one order). */
export function aggregateHeatmapEvents(events: HeatmapEvent[]): HeatmapAggregates {
  const clicks = new Map<string, HeatmapAggregates['clicks'][number]>();
  const targets = new Map<string, HeatmapAggregates['targets'][number]>();
  const scrolls = new Map<string, HeatmapAggregates['scrolls'][number]>();
  const pages = new Set<string>();
  for (const e of events) {
    pages.add(e.page);
    if (e.type === 'click') {
      const x = cellIndex(e.x);
      const y = cellIndex(e.y);
      const k = `${e.page}\u0000${e.viewport}\u0000${x}\u0000${y}`;
      const row = clicks.get(k);
      if (row) row.count++;
      else clicks.set(k, { page: e.page, viewport: e.viewport, x, y, count: 1 });
      if (e.selector) {
        const tk = `${e.page}\u0000${e.viewport}\u0000${e.selector}`;
        const t = targets.get(tk);
        if (t) t.count++;
        else targets.set(tk, { page: e.page, viewport: e.viewport, selector: e.selector, count: 1 });
      }
    } else {
      const depth = depthBucket(e.depth);
      const k = `${e.page}\u0000${e.viewport}\u0000${depth}`;
      const row = scrolls.get(k);
      if (row) row.count++;
      else scrolls.set(k, { page: e.page, viewport: e.viewport, depth, count: 1 });
    }
  }
  const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  return { pages: [...pages].sort(), clicks: sorted(clicks), targets: sorted(targets), scrolls: sorted(scrolls) };
}

/** UTC day (YYYY-MM-DD). */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

type Queryable = Pick<DataSource, 'query'>;

export interface PersistOptions {
  day?: string;
  maxPages?: number;
}

/**
 * Page admission (synchronous at request time, so responses stay accurate): pages new to the
 * project are accepted only while the project stays under `maxPages` distinct pages (bounds
 * table growth from crafted paths). Inserts new pages / bumps `last_day` and returns the
 * refused pages, whose events must be dropped.
 */
export async function admitHeatmapPages(
  db: Queryable,
  projectId: string,
  pages: string[],
  opts: PersistOptions = {},
): Promise<{ day: string; refused: Set<string> }> {
  const day = opts.day || utcDay();
  const maxPages = opts.maxPages ?? maxPagesPerProject();
  const refused = new Set<string>();
  if (!pages.length) return { day, refused };

  const existing: Array<{ page: string; last_day: string | Date }> = await db.query(
    'SELECT page, last_day FROM heatmap_pages WHERE project_id = $1 AND page = ANY($2::text[])',
    [projectId, pages],
  );
  const known = new Set(existing.map((r) => r.page));
  const dayOf = (v: string | Date) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  // Pages seen earlier today need no write: rewriting the same heatmap_pages row on every
  // request serialised concurrent ingests on that row's lock.
  const stale = existing.filter((r) => dayOf(r.last_day) < day).map((r) => r.page).sort();
  const fresh = pages.filter((p) => !known.has(p));
  if (fresh.length) {
    const [{ n }] = await db.query('SELECT count(*)::int AS n FROM heatmap_pages WHERE project_id = $1', [projectId]);
    const room = Math.max(0, maxPages - Number(n));
    fresh.slice(room).forEach((p) => refused.add(p));
  }
  const allowed = pages.filter((p) => !refused.has(p));
  if (!allowed.length) return { day, refused };

  const inserts = allowed.filter((p) => !known.has(p)).sort();
  if (inserts.length) {
    await db.query(
      `INSERT INTO heatmap_pages (project_id, page, first_day, last_day)
       SELECT $1::uuid, p, $2::date, $2::date FROM unnest($3::text[]) AS p
       ON CONFLICT (project_id, page) DO UPDATE SET last_day = GREATEST(heatmap_pages.last_day, EXCLUDED.last_day)
       WHERE heatmap_pages.last_day < EXCLUDED.last_day`,
      [projectId, day, inserts],
    );
  }
  if (stale.length) {
    await db.query(
      `UPDATE heatmap_pages SET last_day = $2::date
       WHERE project_id = $1 AND page = ANY($3::text[]) AND last_day < $2::date`,
      [projectId, day, stale],
    );
  }
  return { day, refused };
}

/** One additive count increment, fully keyed (project + day + the table's own key). */
export type HeatmapCountRow =
  | { table: 'clicks'; projectId: string; day: string; page: string; viewport: string; x: number; y: number; count: number }
  | { table: 'targets'; projectId: string; day: string; page: string; viewport: string; selector: string; count: number }
  | { table: 'scrolls'; projectId: string; day: string; page: string; viewport: string; depth: number; count: number };

const pad6 = (n: number) => String(n).padStart(6, '0');

/** Stable key matching each table's conflict key; sorting by it locks rows in one global order. */
export function heatmapRowKey(r: HeatmapCountRow): string {
  const head = `${r.table} ${r.projectId} ${r.page} ${r.viewport} ${r.day}`;
  if (r.table === 'clicks') return `${head} ${pad6(r.x)} ${pad6(r.y)}`;
  if (r.table === 'targets') return `${head} ${r.selector}`;
  return `${head} ${pad6(r.depth)}`;
}

/** One batch's aggregates -> keyed count rows, without refused pages. */
export function heatmapCountRows(projectId: string, day: string, agg: HeatmapAggregates, refused: Set<string> = new Set()): HeatmapCountRow[] {
  const rows: HeatmapCountRow[] = [];
  for (const r of agg.clicks) if (!refused.has(r.page)) rows.push({ table: 'clicks', projectId, day, ...r });
  for (const r of agg.targets) if (!refused.has(r.page)) rows.push({ table: 'targets', projectId, day, ...r });
  for (const r of agg.scrolls) if (!refused.has(r.page)) rows.push({ table: 'scrolls', projectId, day, ...r });
  return rows;
}

/** Events represented by count rows (clicks + scroll views; targets duplicate clicks). */
export function storedEvents(rows: HeatmapCountRow[]): number {
  return rows.reduce((a, r) => (r.table === 'targets' ? a : a + r.count), 0);
}

/**
 * Write count rows with additive upserts (`count = count + EXCLUDED.count`), one statement per
 * table, rows sorted by conflict key: concurrent multi-row upserts (other replicas, other
 * flushes) lock rows in the same order and cannot deadlock. Additive upserts keep totals exact
 * with any number of API replicas buffering independently.
 */
export async function writeHeatmapCounts(db: Queryable, input: HeatmapCountRow[]): Promise<void> {
  const rows = input
    .map((r) => [heatmapRowKey(r), r] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, r]) => r);
  const clicks = rows.filter((r): r is Extract<HeatmapCountRow, { table: 'clicks' }> => r.table === 'clicks');
  const targets = rows.filter((r): r is Extract<HeatmapCountRow, { table: 'targets' }> => r.table === 'targets');
  const scrolls = rows.filter((r): r is Extract<HeatmapCountRow, { table: 'scrolls' }> => r.table === 'scrolls');
  if (clicks.length) {
    await db.query(
      `INSERT INTO heatmap_click_cells (project_id, day, page, viewport, cell_x, cell_y, count)
       SELECT t.project_id, t.day, t.page, t.viewport, t.x, t.y, t.n
       FROM unnest($1::uuid[], $2::date[], $3::text[], $4::text[], $5::int[], $6::int[], $7::int[]) AS t(project_id, day, page, viewport, x, y, n)
       ON CONFLICT (project_id, page, viewport, day, cell_x, cell_y)
       DO UPDATE SET count = heatmap_click_cells.count + EXCLUDED.count`,
      [clicks.map((r) => r.projectId), clicks.map((r) => r.day), clicks.map((r) => r.page), clicks.map((r) => r.viewport), clicks.map((r) => r.x), clicks.map((r) => r.y), clicks.map((r) => r.count)],
    );
  }
  if (targets.length) {
    await db.query(
      `INSERT INTO heatmap_click_targets (project_id, day, page, viewport, selector, count)
       SELECT t.project_id, t.day, t.page, t.viewport, t.selector, t.n
       FROM unnest($1::uuid[], $2::date[], $3::text[], $4::text[], $5::text[], $6::int[]) AS t(project_id, day, page, viewport, selector, n)
       ON CONFLICT (project_id, page, viewport, day, selector)
       DO UPDATE SET count = heatmap_click_targets.count + EXCLUDED.count`,
      [targets.map((r) => r.projectId), targets.map((r) => r.day), targets.map((r) => r.page), targets.map((r) => r.viewport), targets.map((r) => r.selector), targets.map((r) => r.count)],
    );
  }
  if (scrolls.length) {
    await db.query(
      `INSERT INTO heatmap_scroll_depth (project_id, day, page, viewport, depth, count)
       SELECT t.project_id, t.day, t.page, t.viewport, t.depth, t.n
       FROM unnest($1::uuid[], $2::date[], $3::text[], $4::text[], $5::int[], $6::int[]) AS t(project_id, day, page, viewport, depth, n)
       ON CONFLICT (project_id, page, viewport, day, depth)
       DO UPDATE SET count = heatmap_scroll_depth.count + EXCLUDED.count`,
      [scrolls.map((r) => r.projectId), scrolls.map((r) => r.day), scrolls.map((r) => r.page), scrolls.map((r) => r.viewport), scrolls.map((r) => r.depth), scrolls.map((r) => r.count)],
    );
  }
}

/**
 * Admit pages and write one batch's counts directly (unbuffered). The ingest route buffers
 * instead (`heatmap-buffer.ts`). Returns the number of events stored.
 */
export async function persistHeatmapAggregates(
  db: Queryable,
  projectId: string,
  agg: HeatmapAggregates,
  opts: PersistOptions = {},
): Promise<{ stored: number; refusedPages: string[] }> {
  if (!agg.pages.length) return { stored: 0, refusedPages: [] };
  const { day, refused } = await admitHeatmapPages(db, projectId, agg.pages, opts);
  const rows = heatmapCountRows(projectId, day, agg, refused);
  if (rows.length) await writeHeatmapCounts(db, rows);
  return { stored: storedEvents(rows), refusedPages: [...refused] };
}

// ------------------------------------------------------------------ queries

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const s = raw.trim();
  const d = new Date(DAY_RE.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : utcDay(d);
}

/** Query date range (inclusive UTC days). Default: the last 7 days. */
export function parseHeatmapRange(
  fromRaw: unknown,
  toRaw: unknown,
  now: Date = new Date(),
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const to = toRaw === undefined || toRaw === '' ? utcDay(now) : parseDay(toRaw);
  if (!to) return { ok: false, error: 'to must be a date (YYYY-MM-DD or ISO 8601)' };
  const defFrom = utcDay(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000));
  const from = fromRaw === undefined || fromRaw === '' ? defFrom : parseDay(fromRaw);
  if (!from) return { ok: false, error: 'from must be a date (YYYY-MM-DD or ISO 8601)' };
  if (from > to) return { ok: false, error: 'from must not be after to' };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) return { ok: false, error: `range must be at most ${MAX_RANGE_DAYS} days` };
  return { ok: true, from, to };
}

export interface HeatmapQuery {
  projectId: string;
  page: string;
  from: string;
  to: string;
  viewport: ViewportBucket | null;
}

export interface ClickHeatmap {
  type: 'click';
  page: string;
  viewport: ViewportBucket | 'all';
  from: string;
  to: string;
  grid: { cols: number; rows: number };
  total: number;
  maxCell: number;
  /** [cellX, cellY, count] triples (sparse). */
  cells: Array<[number, number, number]>;
  topTargets: Array<{ selector: string; count: number }>;
}

export async function queryClickHeatmap(db: Queryable, q: HeatmapQuery): Promise<ClickHeatmap> {
  const params = [q.projectId, q.page, q.from, q.to, q.viewport];
  const rows: Array<{ cell_x: number; cell_y: number; count: string | number }> = await db.query(
    `SELECT cell_x, cell_y, SUM(count)::bigint AS count FROM heatmap_click_cells
     WHERE project_id = $1 AND page = $2 AND day BETWEEN $3::date AND $4::date AND ($5::text IS NULL OR viewport = $5)
     GROUP BY cell_x, cell_y`,
    params,
  );
  const targets: Array<{ selector: string; count: string | number }> = await db.query(
    `SELECT selector, SUM(count)::bigint AS count FROM heatmap_click_targets
     WHERE project_id = $1 AND page = $2 AND day BETWEEN $3::date AND $4::date AND ($5::text IS NULL OR viewport = $5)
     GROUP BY selector ORDER BY count DESC, selector LIMIT 20`,
    params,
  );
  const cells = rows.map((r) => [Number(r.cell_x), Number(r.cell_y), Number(r.count)] as [number, number, number]);
  return {
    type: 'click',
    page: q.page,
    viewport: q.viewport || 'all',
    from: q.from,
    to: q.to,
    grid: { cols: HEATMAP_GRID, rows: HEATMAP_GRID },
    total: cells.reduce((a, c) => a + c[2], 0),
    maxCell: cells.reduce((a, c) => Math.max(a, c[2]), 0),
    cells,
    topTargets: targets.map((t) => ({ selector: t.selector, count: Number(t.count) })),
  };
}

export interface ScrollHeatmap {
  type: 'scroll';
  page: string;
  viewport: ViewportBucket | 'all';
  from: string;
  to: string;
  views: number;
  /** Page views whose max depth fell in [depth, depth + 5). */
  buckets: Array<{ depth: number; count: number }>;
  /** Share (0..100) of page views that reached at least `depth` percent. */
  reach: Array<{ depth: number; pct: number }>;
}

/** Histogram (any order, gaps allowed) -> full 0..100 buckets + cumulative reach curve. */
export function scrollReach(rows: Array<{ depth: number; count: number }>): Pick<ScrollHeatmap, 'views' | 'buckets' | 'reach'> {
  const byDepth = new Map<number, number>();
  for (const r of rows) byDepth.set(depthBucket(r.depth), (byDepth.get(depthBucket(r.depth)) || 0) + r.count);
  const buckets: Array<{ depth: number; count: number }> = [];
  for (let d = 0; d <= 100; d += SCROLL_BUCKET) buckets.push({ depth: d, count: byDepth.get(d) || 0 });
  const views = buckets.reduce((a, b) => a + b.count, 0);
  const reach: Array<{ depth: number; pct: number }> = [];
  let atLeast = views;
  for (const b of buckets) {
    reach.push({ depth: b.depth, pct: views ? Math.round((atLeast / views) * 1000) / 10 : 0 });
    atLeast -= b.count;
  }
  return { views, buckets, reach };
}

export async function queryScrollHeatmap(db: Queryable, q: HeatmapQuery): Promise<ScrollHeatmap> {
  const rows: Array<{ depth: number; count: string | number }> = await db.query(
    `SELECT depth, SUM(count)::bigint AS count FROM heatmap_scroll_depth
     WHERE project_id = $1 AND page = $2 AND day BETWEEN $3::date AND $4::date AND ($5::text IS NULL OR viewport = $5)
     GROUP BY depth`,
    [q.projectId, q.page, q.from, q.to, q.viewport],
  );
  return {
    type: 'scroll',
    page: q.page,
    viewport: q.viewport || 'all',
    from: q.from,
    to: q.to,
    ...scrollReach(rows.map((r) => ({ depth: Number(r.depth), count: Number(r.count) }))),
  };
}

export interface HeatmapPageSummary {
  page: string;
  clicks: number;
  views: number;
}

export async function listHeatmapPages(
  db: Queryable,
  q: Omit<HeatmapQuery, 'page'>,
): Promise<HeatmapPageSummary[]> {
  const rows: Array<{ page: string; clicks: string | number; views: string | number }> = await db.query(
    `SELECT p.page, COALESCE(c.clicks, 0)::bigint AS clicks, COALESCE(s.views, 0)::bigint AS views
     FROM heatmap_pages p
     LEFT JOIN (SELECT page, SUM(count) AS clicks FROM heatmap_click_cells
                WHERE project_id = $1 AND day BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR viewport = $4)
                GROUP BY page) c ON c.page = p.page
     LEFT JOIN (SELECT page, SUM(count) AS views FROM heatmap_scroll_depth
                WHERE project_id = $1 AND day BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR viewport = $4)
                GROUP BY page) s ON s.page = p.page
     WHERE p.project_id = $1 AND (c.clicks IS NOT NULL OR s.views IS NOT NULL)
     ORDER BY views DESC, clicks DESC, p.page LIMIT 200`,
    [q.projectId, q.from, q.to, q.viewport],
  );
  return rows.map((r) => ({ page: r.page, clicks: Number(r.clicks), views: Number(r.views) }));
}

// ------------------------------------------------------------------ retention

export const HEATMAP_RETENTION_JOB = 'heatmaps-retention';
const HEATMAP_TABLES = ['heatmap_click_cells', 'heatmap_click_targets', 'heatmap_scroll_depth'] as const;

/**
 * SQL for the per-project retention cutoff: #47 `retention_days.heatmaps` (clamped 1..365 like
 * mergeRetention) or the default. `$1` = default days.
 */
const RETENTION_SUBQUERY = `SELECT p.id AS project_id,
    (CURRENT_DATE - LEAST(365, GREATEST(1, COALESCE(
      CASE WHEN jsonb_typeof(s.retention_days -> 'heatmaps') = 'number'
           THEN floor((s.retention_days ->> 'heatmaps')::numeric)::int END, $1))))::date AS cutoff
  FROM projects p LEFT JOIN telemetry_privacy_settings s ON s.project_id = p.id`;

/** Delete aggregates older than each project's heatmap retention. Returns rows deleted per table. */
export async function pruneHeatmaps(db: Queryable, defaultDays = DEFAULT_RETENTION_DAYS.heatmaps): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of HEATMAP_TABLES) {
    const res: any = await db.query(
      `DELETE FROM ${table} h USING (${RETENTION_SUBQUERY}) r WHERE h.project_id = r.project_id AND h.day < r.cutoff`,
      [defaultDays],
    );
    out[table] = affected(res);
  }
  const res: any = await db.query(
    `DELETE FROM heatmap_pages h USING (${RETENTION_SUBQUERY}) r WHERE h.project_id = r.project_id AND h.last_day < r.cutoff`,
    [defaultDays],
  );
  out.heatmap_pages = affected(res);
  return out;
}

function affected(res: any): number {
  // TypeORM postgres driver returns [rows, rowCount] for DELETE.
  if (Array.isArray(res) && typeof res[1] === 'number') return res[1];
  if (res && typeof res.rowCount === 'number') return res.rowCount;
  return 0;
}
