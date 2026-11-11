import {
  HEATMAP_GRID,
  MAX_EVENTS_PER_BATCH,
  aggregateHeatmapEvents,
  cellIndex,
  depthBucket,
  normalizeHeatmapPage,
  parseHeatmapRange,
  persistHeatmapAggregates,
  pruneHeatmaps,
  queryClickHeatmap,
  sanitizeSelector,
  scrollReach,
  validateHeatmapBatch,
  viewportBucket,
} from '../../../src/lib/heatmaps';
import { mergeRetention, parseRetentionPatch } from '../../../src/lib/privacy-settings';

const PROJECT = '11111111-1111-4111-8111-111111111111';

function fakeDb(handler: (sql: string, params: any[]) => any = () => []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return handler(sql, params);
    }),
  };
}

describe('page normalisation (same rules as RUM view names)', () => {
  it('drops origin, query and fragment and collapses dynamic segments', () => {
    expect(normalizeHeatmapPage('/orders/42?tab=1#x')).toBe('/orders/:id');
    expect(normalizeHeatmapPage('https://shop.example.test/u/550e8400-e29b-41d4-a716-446655440000/edit')).toBe('/u/:id/edit');
    expect(normalizeHeatmapPage('/users/jane%40example.com')).toBe('/users/:email');
    expect(normalizeHeatmapPage('/t/abcdefabcdefabcdef')).toBe('/t/:id');
    expect(normalizeHeatmapPage('/')).toBe('/');
    expect(normalizeHeatmapPage('//a//b/')).toBe('/a/b');
  });
  it('rejects non-paths', () => {
    for (const v of ['', 'pricing', 42, null, undefined, 'javascript:alert(1)']) expect(normalizeHeatmapPage(v)).toBeNull();
  });
  it('replaces odd segments and bounds length', () => {
    expect(normalizeHeatmapPage('/a/<script>')).toBe('/a/:id');
    expect(normalizeHeatmapPage('/' + 'abc/'.repeat(200))!.length).toBeLessThanOrEqual(512);
  });
});

describe('selector and viewport', () => {
  it('keeps tag/id/class selectors, drops text-like or oversized values', () => {
    expect(sanitizeSelector('main > button#buy.btn:nth-of-type(2)')).toBe('main > button#buy.btn:nth-of-type(2)');
    expect(sanitizeSelector('button[data-rum-name="checkout"]')).toBe('button[data-rum-name="checkout"]');
    expect(sanitizeSelector('a[data-x="me@example.com"]')).toBeNull();
    expect(sanitizeSelector('<img onerror=x>')).toBeNull();
    expect(sanitizeSelector('a'.repeat(300))).toBeNull();
  });
  it('buckets widths like the SDK', () => {
    expect(viewportBucket(390)).toBe('mobile');
    expect(viewportBucket(767)).toBe('mobile');
    expect(viewportBucket(768)).toBe('tablet');
    expect(viewportBucket(1023)).toBe('tablet');
    expect(viewportBucket(1440)).toBe('desktop');
    expect(viewportBucket(NaN)).toBe('mobile');
  });
});

describe('validateHeatmapBatch', () => {
  it('rejects bad envelopes', () => {
    expect(validateHeatmapBatch(null).ok).toBe(false);
    expect(validateHeatmapBatch({}).ok).toBe(false);
    expect(validateHeatmapBatch({ events: [] }).ok).toBe(false);
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({ type: 'scroll', page: '/', viewport: 'desktop', depth: 1 }));
    expect(validateHeatmapBatch({ events: many }).ok).toBe(false);
  });
  it('keeps valid events, drops invalid ones individually', () => {
    const r = validateHeatmapBatch({
      subjectId: 'u1',
      events: [
        { type: 'click', page: '/a', viewport: 'desktop', x: 0.5, y: 0.25, selector: 'button#go' },
        { type: 'click', page: '/a', viewportWidth: 400, x: 1.005, y: 0, selector: 'bad <x>' },
        { type: 'click', page: '/a', viewport: 'desktop', x: 2, y: 0.1 },
        { type: 'click', page: '/a', viewport: 'huge', x: 0.1, y: 0.1 },
        { type: 'scroll', page: '/a', viewport: 'tablet', depth: 73 },
        { type: 'scroll', page: '/a', viewport: 'tablet', depth: 101 },
        { type: 'other', page: '/a', viewport: 'tablet' },
        'nope',
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok !== true) return;
    expect(r.subjectId).toBe('u1');
    expect(r.events).toEqual([
      { type: 'click', page: '/a', viewport: 'desktop', x: 0.5, y: 0.25, selector: 'button#go' },
      { type: 'click', page: '/a', viewport: 'mobile', x: 1, y: 0, selector: null },
      { type: 'scroll', page: '/a', viewport: 'tablet', depth: 73 },
    ]);
    expect(r.dropped).toBe(5);
  });
  it('caps distinct pages per batch', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ type: 'scroll', page: `/p${i}x`, viewport: 'desktop', depth: 10 }));
    const r = validateHeatmapBatch({ events });
    expect(r.ok && r.events.length).toBe(20);
    expect(r.ok && r.dropped).toBe(10);
  });
});

describe('aggregation math', () => {
  it('maps fractions to a 100x100 grid and 5% depth buckets', () => {
    expect(HEATMAP_GRID).toBe(100);
    expect(cellIndex(0)).toBe(0);
    expect(cellIndex(0.999)).toBe(99);
    expect(cellIndex(1)).toBe(99);
    expect(cellIndex(0.505)).toBe(50);
    expect(depthBucket(0)).toBe(0);
    expect(depthBucket(4.9)).toBe(0);
    expect(depthBucket(73)).toBe(70);
    expect(depthBucket(100)).toBe(100);
  });
  it('folds events into counts per page/viewport/cell, selector and depth bucket', () => {
    const agg = aggregateHeatmapEvents([
      { type: 'click', page: '/a', viewport: 'desktop', x: 0.501, y: 0.2, selector: 'button#go' },
      { type: 'click', page: '/a', viewport: 'desktop', x: 0.509, y: 0.205, selector: 'button#go' },
      { type: 'click', page: '/a', viewport: 'mobile', x: 0.501, y: 0.2, selector: null },
      { type: 'scroll', page: '/a', viewport: 'desktop', depth: 72 },
      { type: 'scroll', page: '/a', viewport: 'desktop', depth: 74.9 },
      { type: 'scroll', page: '/b', viewport: 'desktop', depth: 100 },
    ]);
    expect(agg.pages).toEqual(['/a', '/b']);
    expect(agg.clicks).toEqual([
      { page: '/a', viewport: 'desktop', x: 50, y: 20, count: 2 },
      { page: '/a', viewport: 'mobile', x: 50, y: 20, count: 1 },
    ]);
    expect(agg.targets).toEqual([{ page: '/a', viewport: 'desktop', selector: 'button#go', count: 2 }]);
    expect(agg.scrolls).toEqual([
      { page: '/a', viewport: 'desktop', depth: 70, count: 2 },
      { page: '/b', viewport: 'desktop', depth: 100, count: 1 },
    ]);
  });
  it('scroll reach is the cumulative share of views reaching each depth', () => {
    const r = scrollReach([{ depth: 100, count: 1 }, { depth: 50, count: 2 }, { depth: 0, count: 1 }]);
    expect(r.views).toBe(4);
    expect(r.buckets).toHaveLength(21);
    const at = (d: number) => r.reach.find((x) => x.depth === d)!.pct;
    expect(at(0)).toBe(100);
    expect(at(5)).toBe(75);
    expect(at(50)).toBe(75);
    expect(at(55)).toBe(25);
    expect(at(100)).toBe(25);
    expect(scrollReach([]).reach.every((x) => x.pct === 0)).toBe(true);
  });
});

describe('persistHeatmapAggregates', () => {
  const agg = aggregateHeatmapEvents([
    { type: 'click', page: '/known', viewport: 'desktop', x: 0.1, y: 0.1, selector: 'a#x' },
    { type: 'click', page: '/new1', viewport: 'desktop', x: 0.1, y: 0.1, selector: null },
    { type: 'scroll', page: '/new2', viewport: 'desktop', depth: 50 },
  ]);

  it('upserts additive counts with unnest arrays (no raw events, no identifiers)', async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith('SELECT page')) return [{ page: '/known' }];
      if (sql.startsWith('SELECT count')) return [{ n: 1 }];
      return [];
    });
    const r = await persistHeatmapAggregates(db, PROJECT, agg, { day: '2026-11-10', maxPages: 100 });
    expect(r).toEqual({ stored: 3, refusedPages: [] });
    const cells = db.calls.find((c) => c.sql.includes('INSERT INTO heatmap_click_cells'))!;
    expect(cells.sql).toMatch(/count = heatmap_click_cells\.count \+ EXCLUDED\.count/);
    expect(cells.params).toEqual([PROJECT, '2026-11-10', ['/known', '/new1'], ['desktop', 'desktop'], [10, 10], [10, 10], [1, 1]]);
    const targets = db.calls.find((c) => c.sql.includes('INSERT INTO heatmap_click_targets'))!;
    expect(targets.params[4]).toEqual(['a#x']);
    const scroll = db.calls.find((c) => c.sql.includes('INSERT INTO heatmap_scroll_depth'))!;
    expect(scroll.params).toEqual([PROJECT, '2026-11-10', ['/new2'], ['desktop'], [50], [1]]);
    for (const c of db.calls) expect(JSON.stringify(c.params)).not.toMatch(/subject|session|ip/i);
  });

  it('refuses new pages once the project page cap is reached (known pages still count)', async () => {
    const db = fakeDb((sql) => {
      if (sql.startsWith('SELECT page')) return [{ page: '/known', last_day: '2026-11-09' }];
      if (sql.startsWith('SELECT count')) return [{ n: 2 }];
      return [];
    });
    const r = await persistHeatmapAggregates(db, PROJECT, agg, { day: '2026-11-10', maxPages: 3 });
    expect(r.refusedPages).toEqual(['/new2']);
    expect(r.stored).toBe(2);
    expect(db.calls.some((c) => c.sql.includes('heatmap_scroll_depth'))).toBe(false);
    // Only new pages are inserted; a known page last seen yesterday gets one guarded UPDATE.
    const pages = db.calls.find((c) => c.sql.includes('INSERT INTO heatmap_pages'))!;
    expect(pages.params[2]).toEqual(['/new1']);
    const touch = db.calls.find((c) => c.sql.includes('UPDATE heatmap_pages'))!;
    expect(touch.params[2]).toEqual(['/known']);
  });

  it('does not write heatmap_pages for pages already seen today (no hot-row rewrite)', async () => {
    const db = fakeDb((sql) => (sql.startsWith('SELECT page') ? agg.pages.map((page) => ({ page, last_day: new Date('2026-11-10T00:00:00Z') })) : []));
    await persistHeatmapAggregates(db, PROJECT, agg, { day: '2026-11-10', maxPages: 100 });
    expect(db.calls.some((c) => /INSERT INTO heatmap_pages|UPDATE heatmap_pages/.test(c.sql))).toBe(false);
    expect(db.calls.some((c) => c.sql.includes('heatmap_click_cells'))).toBe(true);
  });
});

describe('queries and range', () => {
  it('defaults to the last 7 days and validates input', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    expect(parseHeatmapRange(undefined, undefined, now)).toEqual({ ok: true, from: '2026-11-04', to: '2026-11-10' });
    expect(parseHeatmapRange('2026-11-01', '2026-11-02', now)).toEqual({ ok: true, from: '2026-11-01', to: '2026-11-02' });
    expect(parseHeatmapRange('2026-11-05', '2026-11-01', now).ok).toBe(false);
    expect(parseHeatmapRange('nope', undefined, now).ok).toBe(false);
    expect(parseHeatmapRange('2020-01-01', '2026-01-01', now).ok).toBe(false);
  });
  it('click query returns sparse cells, totals and the max cell', async () => {
    const db = fakeDb((sql) => (sql.includes('heatmap_click_cells')
      ? [{ cell_x: 1, cell_y: 2, count: '5' }, { cell_x: 3, cell_y: 4, count: '7' }]
      : [{ selector: 'a#x', count: '9' }]));
    const r = await queryClickHeatmap(db, { projectId: PROJECT, page: '/a', from: '2026-11-01', to: '2026-11-07', viewport: null });
    expect(r).toMatchObject({ total: 12, maxCell: 7, viewport: 'all', grid: { cols: 100, rows: 100 }, cells: [[1, 2, 5], [3, 4, 7]], topTargets: [{ selector: 'a#x', count: 9 }] });
    expect(db.calls[0].params).toEqual([PROJECT, '/a', '2026-11-01', '2026-11-07', null]);
  });
});

describe('retention', () => {
  it('heatmaps is a #47 retention type (default 90 days, 1..365)', () => {
    expect(mergeRetention({}).heatmaps).toBe(90);
    expect(mergeRetention({ heatmaps: 999 }).heatmaps).toBe(365);
    expect(parseRetentionPatch({ heatmaps: 14 })).toEqual({ ok: true, value: { heatmaps: 14 } });
    expect(parseRetentionPatch({ heatmaps: 0 }).ok).toBe(false);
  });
  it('prunes every aggregate table using per-project retention with the default fallback', async () => {
    const db = fakeDb(() => [[], 3]);
    const r = await pruneHeatmaps(db, 90);
    expect(r).toEqual({ heatmap_click_cells: 3, heatmap_click_targets: 3, heatmap_scroll_depth: 3, heatmap_pages: 3 });
    expect(db.calls).toHaveLength(4);
    for (const c of db.calls) {
      expect(c.sql).toMatch(/retention_days -> 'heatmaps'/);
      expect(c.sql).toMatch(/LEAST\(365, GREATEST\(1/);
      expect(c.params).toEqual([90]);
    }
  });
});
