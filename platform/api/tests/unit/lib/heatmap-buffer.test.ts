import { aggregateHeatmapEvents, type HeatmapEvent } from '../../../src/lib/heatmaps';
import {
  HeatmapBuffer,
  bufferHeatmapAggregates,
  flushHeatmapBuffer,
  heatmapBuffer,
  heatmapBufferMaxKeys,
  heatmapFlushMs,
  resetHeatmapBufferForTests,
} from '../../../src/lib/heatmap-buffer';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-11-10';

function fakeDb(opts: { knownPages?: string[]; pageCount?: number; failWrites?: number } = {}) {
  const calls: Array<{ sql: string; params: any[]; tx: boolean }> = [];
  let failures = opts.failWrites || 0;
  let transactions = 0;
  const run = (tx: boolean) => async (sql: string, params: any[] = []): Promise<any> => {
    calls.push({ sql, params, tx });
    if (sql.startsWith('SELECT page')) return (opts.knownPages || []).map((page) => ({ page, last_day: DAY }));
    if (sql.startsWith('SELECT count')) return [{ n: opts.pageCount ?? 0 }];
    if (tx && failures > 0 && sql.startsWith('INSERT INTO heatmap_')) {
      failures--;
      throw new Error('db down');
    }
    return [];
  };
  return {
    calls,
    get transactions() { return transactions; },
    query: jest.fn(run(false)),
    transaction: jest.fn(async (fn: (m: { query: any }) => Promise<unknown>) => {
      transactions++;
      return fn({ query: run(true) });
    }),
    writes: () => calls.filter((c) => /INSERT INTO heatmap_(click_cells|click_targets|scroll_depth)/.test(c.sql)),
  };
}

const click = (page: string, x = 0.5, selector: string | null = 'a#buy'): HeatmapEvent => ({ type: 'click', page, viewport: 'desktop', x, y: 0.5, selector });
const scroll = (page: string, depth = 80): HeatmapEvent => ({ type: 'scroll', page, viewport: 'desktop', depth });

/** Sum of counts per table from the INSERT params (last param array is the counts). */
function totals(db: ReturnType<typeof fakeDb>) {
  const out: Record<string, number> = {};
  for (const w of db.writes()) {
    const table = /INSERT INTO (\w+)/.exec(w.sql)![1];
    out[table] = (out[table] || 0) + (w.params[w.params.length - 1] as number[]).reduce((a, n) => a + n, 0);
  }
  return out;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  resetHeatmapBufferForTests();
  jest.useRealTimers();
});

describe('env knobs', () => {
  it('defaults and clamps HEATMAP_FLUSH_MS / HEATMAP_BUFFER_MAX_KEYS', () => {
    expect(heatmapFlushMs({})).toBe(2000);
    expect(heatmapFlushMs({ HEATMAP_FLUSH_MS: '500' })).toBe(500);
    expect(heatmapFlushMs({ HEATMAP_FLUSH_MS: 'x' })).toBe(2000);
    expect(heatmapBufferMaxKeys({})).toBe(20_000);
    expect(heatmapBufferMaxKeys({ HEATMAP_BUFFER_MAX_KEYS: '10' })).toBe(10);
    expect(heatmapBufferMaxKeys({ HEATMAP_BUFFER_MAX_KEYS: '0' })).toBe(20_000);
  });
});

describe('HeatmapBuffer', () => {
  it('holds counts until the flush interval, then writes exact totals in one transaction', async () => {
    const db = fakeDb();
    const buffer = new HeatmapBuffer({ flushMs: 2000, maxKeys: 1000 });
    for (let i = 0; i < 25; i++) {
      const r = await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([click('/a'), click('/a'), scroll('/a')]), { day: DAY, buffer });
      expect(r).toEqual({ stored: 3, refusedPages: [] });
    }
    expect(db.writes()).toHaveLength(0);
    // Same keys across requests collapse: 1 click cell, 1 target, 1 scroll bucket.
    expect(buffer.size).toBe(3);

    await jest.advanceTimersByTimeAsync(1999);
    expect(db.writes()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(db.transactions).toBe(1);
    expect(db.writes().every((w) => w.tx)).toBe(true);
    expect(totals(db)).toEqual({ heatmap_click_cells: 50, heatmap_click_targets: 50, heatmap_scroll_depth: 25 });
    const cells = db.writes().find((w) => w.sql.includes('heatmap_click_cells'))!;
    expect(cells.sql).toMatch(/count = heatmap_click_cells\.count \+ EXCLUDED\.count/);
    expect(cells.params).toEqual([[PROJECT], [DAY], ['/a'], ['desktop'], [50], [50], [50]]);
    expect(buffer.size).toBe(0);

    // Nothing pending: no further writes.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(db.transactions).toBe(1);
  });

  it('flushes as soon as the key cap is reached', async () => {
    const db = fakeDb();
    const buffer = new HeatmapBuffer({ flushMs: 60_000, maxKeys: 4 });
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([click('/a', 0.1, null), click('/a', 0.2, null)]), { day: DAY, buffer });
    expect(db.transactions).toBe(0);
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([click('/a', 0.3, null), click('/a', 0.4, null)]), { day: DAY, buffer });
    await jest.advanceTimersByTimeAsync(0);
    expect(db.transactions).toBe(1);
    expect(totals(db)).toEqual({ heatmap_click_cells: 4 });
    expect(buffer.size).toBe(0);
  });

  it('writes rows sorted by conflict key across projects, pages and days', async () => {
    const db = fakeDb();
    const buffer = new HeatmapBuffer({ flushMs: 2000, maxKeys: 1000 });
    await bufferHeatmapAggregates(db, OTHER, aggregateHeatmapEvents([scroll('/z', 90), scroll('/b', 10)]), { day: DAY, buffer });
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([scroll('/z', 50), scroll('/b', 95), scroll('/b', 5)]), { day: '2026-11-11', buffer });
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([scroll('/b', 5)]), { day: DAY, buffer });
    await buffer.flush();
    const w = db.writes().find((c) => c.sql.includes('heatmap_scroll_depth'))!;
    const [projects, days, pages, , depths] = w.params;
    const keys = projects.map((p: string, i: number) => `${p} ${pages[i]} ${days[i]} ${String(depths[i]).padStart(3, '0')}`);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual([
      `${PROJECT} /b 2026-11-10 005`,
      `${PROJECT} /b 2026-11-11 005`,
      `${PROJECT} /b 2026-11-11 095`,
      `${PROJECT} /z 2026-11-11 050`,
      `${OTHER} /b 2026-11-10 010`,
      `${OTHER} /z 2026-11-10 090`,
    ]);
  });

  it('keeps the page cap synchronous: refused pages are never buffered and the response is exact', async () => {
    const db = fakeDb({ knownPages: ['/known'], pageCount: 2 });
    const buffer = new HeatmapBuffer({ flushMs: 2000, maxKeys: 1000 });
    const r = await bufferHeatmapAggregates(
      db, PROJECT,
      aggregateHeatmapEvents([click('/known'), click('/new1', 0.5, null), scroll('/new2')]),
      { day: DAY, maxPages: 3, buffer },
    );
    expect(r).toEqual({ stored: 2, refusedPages: ['/new2'] });
    // heatmap_pages admission happened at request time, before any flush.
    expect(db.calls.find((c) => c.sql.includes('INSERT INTO heatmap_pages'))!.params[2]).toEqual(['/new1']);
    await buffer.flush();
    expect(db.calls.some((c) => c.sql.includes('heatmap_scroll_depth'))).toBe(false);
    expect(totals(db)).toEqual({ heatmap_click_cells: 2, heatmap_click_targets: 1 });
  });

  it('keeps counts for retry when a flush fails', async () => {
    const db = fakeDb({ failWrites: 1 });
    const log = jest.fn();
    const buffer = new HeatmapBuffer({ flushMs: 2000, maxKeys: 1000, log });
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([scroll('/a'), scroll('/a')]), { day: DAY, buffer });
    await jest.advanceTimersByTimeAsync(2000);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('flush failed'));
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([scroll('/a')]), { day: DAY, buffer });
    await jest.advanceTimersByTimeAsync(2000);
    const ok = db.writes().filter((w) => w.sql.includes('heatmap_scroll_depth')).pop()!;
    expect(ok.params[5]).toEqual([3]);
    expect(buffer.size).toBe(0);
  });

  it('flushHeatmapBuffer (shutdown hook) writes pending counts of the shared buffer', async () => {
    await expect(flushHeatmapBuffer()).resolves.toBeUndefined();
    const db = fakeDb();
    await bufferHeatmapAggregates(db, PROJECT, aggregateHeatmapEvents([click('/a'), scroll('/a')]), { day: DAY });
    expect(heatmapBuffer().size).toBe(3);
    expect(db.writes()).toHaveLength(0);
    await flushHeatmapBuffer();
    expect(totals(db)).toEqual({ heatmap_click_cells: 1, heatmap_click_targets: 1, heatmap_scroll_depth: 1 });
    expect(heatmapBuffer().size).toBe(0);
  });
});
