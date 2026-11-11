/**
 * Buffered heatmap aggregation.
 *
 * Committing one upsert per ingest request serialised concurrent requests on a few hot rows
 * (every view of a page on one day bumps the same scroll-depth buckets) and paid one WAL sync
 * per request. Instead, each process folds count increments into memory per key and flushes
 * every HEATMAP_FLUSH_MS (default 2000 ms), or as soon as HEATMAP_BUFFER_MAX_KEYS distinct keys
 * are pending, in ONE transaction with rows sorted by conflict key and additive upserts
 * (`count = count + EXCLUDED.count`), so any number of replicas stay exact. The buffer is
 * flushed on graceful shutdown (server.ts closers).
 *
 * Trade-off: a hard crash (SIGKILL, OOM) loses at most one flush interval of counts from that
 * process (documented in docs/guides/heatmaps.md). Page admission (the per-project page cap)
 * stays synchronous at request time, so ingest responses remain accurate.
 */
import type { DataSource } from 'typeorm';
import {
  type HeatmapAggregates,
  type HeatmapCountRow,
  type PersistOptions,
  admitHeatmapPages,
  heatmapCountRows,
  heatmapRowKey,
  storedEvents,
  writeHeatmapCounts,
} from './heatmaps';

type Queryable = Pick<DataSource, 'query'>;
/** A DataSource (transactional flush) or any query-only handle (tests). */
export type HeatmapFlushDb = Queryable & {
  transaction?: (run: (m: Queryable) => Promise<unknown>) => Promise<unknown>;
};

export function heatmapFlushMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HEATMAP_FLUSH_MS);
  return Number.isFinite(n) && n >= 50 ? Math.min(60_000, Math.floor(n)) : 2000;
}

export function heatmapBufferMaxKeys(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.HEATMAP_BUFFER_MAX_KEYS);
  return Number.isFinite(n) && n >= 1 ? Math.min(1_000_000, Math.floor(n)) : 20_000;
}

export interface HeatmapBufferOptions {
  flushMs?: number;
  maxKeys?: number;
  log?: (msg: string) => void;
}

export class HeatmapBuffer {
  readonly flushMs: number;
  readonly maxKeys: number;
  private rows = new Map<string, HeatmapCountRow>();
  private db: HeatmapFlushDb | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly log: (msg: string) => void;

  constructor(opts: HeatmapBufferOptions = {}) {
    this.flushMs = opts.flushMs ?? heatmapFlushMs();
    this.maxKeys = opts.maxKeys ?? heatmapBufferMaxKeys();
    this.log = opts.log || ((m) => console.warn(m));
  }

  /** Distinct keys waiting for the next flush. */
  get size(): number {
    return this.rows.size;
  }

  /** Fold increments into the buffer; flushes at once when the key cap is reached. */
  add(db: HeatmapFlushDb, rows: HeatmapCountRow[]): void {
    if (!rows.length) return;
    this.db = db;
    this.merge(rows);
    if (this.rows.size >= this.maxKeys) {
      void this.flush();
    } else if (!this.timer) {
      // Started by the first pending key: bounds the age of any buffered count to flushMs.
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  /**
   * Write everything pending in one transaction. Flushes are serialised; on failure the counts
   * are put back (up to the key cap) for the next attempt. Never rejects.
   */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushOnce());
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const db = this.db;
    if (!db || !this.rows.size) return;
    const batch = [...this.rows.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
    this.rows = new Map();
    try {
      if (typeof db.transaction === 'function') await db.transaction((m) => writeHeatmapCounts(m, batch));
      else await writeHeatmapCounts(db, batch);
    } catch (err: any) {
      // Keys added meanwhile always merge; other failed keys only while under the cap.
      let room = Math.max(0, this.maxKeys - this.rows.size);
      const retry = batch.filter((r) => this.rows.has(heatmapRowKey(r)) || (room > 0 && room-- > 0));
      this.merge(retry);
      const lost = batch.length - retry.length;
      this.log(`[heatmaps] flush failed (${err?.message || err}); ${retry.length} keys kept for retry${lost ? `, ${lost} dropped` : ''}`);
      if (!this.timer && this.rows.size) {
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.flush();
        }, this.flushMs);
        this.timer.unref?.();
      }
    }
  }

  private merge(rows: HeatmapCountRow[]): void {
    for (const r of rows) {
      const k = heatmapRowKey(r);
      const cur = this.rows.get(k);
      if (cur) cur.count += r.count;
      else this.rows.set(k, { ...r });
    }
  }

  /** Tests only: drop pending counts and the timer. */
  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.rows = new Map();
    this.db = null;
    this.flushing = Promise.resolve();
  }
}

let shared: HeatmapBuffer | null = null;

/** The process-wide buffer used by the ingest route (created on first use from env). */
export function heatmapBuffer(): HeatmapBuffer {
  if (!shared) shared = new HeatmapBuffer();
  return shared;
}

/** Flush pending heatmap counts (graceful shutdown hook). */
export function flushHeatmapBuffer(): Promise<void> {
  return shared ? shared.flush() : Promise.resolve();
}

/** Tests only. */
export function resetHeatmapBufferForTests(): void {
  shared?.reset();
  shared = null;
}

/**
 * Request-time ingest: admit pages synchronously (page cap, refused pages) and buffer the
 * counts of the admitted pages. Returns the events accepted, exactly as an unbuffered write.
 */
export async function bufferHeatmapAggregates(
  db: HeatmapFlushDb,
  projectId: string,
  agg: HeatmapAggregates,
  opts: PersistOptions & { buffer?: HeatmapBuffer } = {},
): Promise<{ stored: number; refusedPages: string[] }> {
  if (!agg.pages.length) return { stored: 0, refusedPages: [] };
  const { day, refused } = await admitHeatmapPages(db, projectId, agg.pages, opts);
  const rows = heatmapCountRows(projectId, day, agg, refused);
  (opts.buffer || heatmapBuffer()).add(db, rows);
  return { stored: storedEvents(rows), refusedPages: [...refused] };
}
