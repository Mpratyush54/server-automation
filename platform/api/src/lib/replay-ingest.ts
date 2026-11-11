/**
 * Session replay chunk validation (#40).
 *
 * The browser SDK uploads one gzip-compressed JSON envelope per chunk
 * (`POST /api/sdk/replay/chunks`, `Content-Type: application/octet-stream`):
 *
 *   { v: 1, sessionId, seq, mode, page, pages[], subjectId, userId?, environment?,
 *     release?, app?, viewport?: {w,h}, startedAt, endedAt, errors, networkErrors,
 *     traceIds[], events: [rrweb events] }
 *
 * The API checks size (compressed and decompressed, so a gzip bomb cannot exhaust
 * memory), structure and identifiers, then stores the bytes as uploaded.
 *
 * | Variable                       | Default        | Meaning |
 * |--------------------------------|----------------|---------|
 * | REPLAY_INGEST                  | (profile)      | `on` / `off`. Default: on when PLATFORM_OBSERVABILITY is set (full profile). |
 * | REPLAY_MAX_CHUNK_BYTES         | 2097152 (2 MiB) | Compressed request body limit (413 above). |
 * | REPLAY_MAX_RAW_BYTES           | 16777216        | Decompressed envelope limit (413 above). |
 * | REPLAY_MAX_EVENTS_PER_CHUNK    | 20000          | |
 * | REPLAY_MAX_CHUNKS_PER_SESSION  | 3000           | 413 for further chunks of that session. |
 * | REPLAY_MAX_SESSION_BYTES       | 104857600       | Compressed bytes per session (413 above). |
 * | REPLAY_RATE_LIMIT              | 600            | Chunk uploads per minute per client IP. |
 */
import { gunzipSync } from 'zlib';
import { observabilityInstalled } from './telemetry-config';

export class ReplayValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export function replayLimits(env: NodeJS.ProcessEnv = process.env) {
  return {
    maxChunkBytes: num(env, 'REPLAY_MAX_CHUNK_BYTES', 2 * 1024 * 1024, 64 * 1024, 10 * 1024 * 1024),
    maxRawBytes: num(env, 'REPLAY_MAX_RAW_BYTES', 16 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
    maxEvents: num(env, 'REPLAY_MAX_EVENTS_PER_CHUNK', 20000, 100, 200000),
    maxChunksPerSession: num(env, 'REPLAY_MAX_CHUNKS_PER_SESSION', 3000, 10, 100000),
    maxSessionBytes: num(env, 'REPLAY_MAX_SESSION_BYTES', 100 * 1024 * 1024, 1024 * 1024, 2 * 1024 * 1024 * 1024),
    rateLimit: num(env, 'REPLAY_RATE_LIMIT', 600, 10, 100000),
  };
}
export type ReplayLimits = ReturnType<typeof replayLimits>;

/** Replay ingest is part of the full observability profile unless switched explicitly. */
export function replayIngestEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.REPLAY_INGEST || '').trim().toLowerCase();
  if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false;
  if (['on', 'true', '1', 'yes', 'enabled'].includes(v)) return true;
  if (env === process.env) return observabilityInstalled();
  return ['1', 'true', 'yes', 'on', 'enabled', 'full'].includes(String(env.PLATFORM_OBSERVABILITY || '').trim().toLowerCase());
}

export const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SUBJECT_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const ENV_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const TRACE_RE = /^[0-9a-f]{32}$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DYNAMIC_SEGMENT = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{16,}$/i,
  /^[A-Za-z0-9_-]{24,}$/,
];

/**
 * Page key: path only (no origin, query or fragment), e-mails redacted, max 512 chars.
 * Accepts absolute URLs (rrweb Meta `href`) and paths.
 */
export function normalizePagePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let path = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.split(/[?#]/)[0];
  if (!path.startsWith('/')) return null;
  path = path.replace(EMAIL_RE, '[EMAIL]').slice(0, 512);
  return path || '/';
}

/** Same low-cardinality view name as the SDK (`/orders/42` -> `/orders/:id`). */
export function routeName(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        /* keep raw */
      }
      if (decoded.includes('@') || decoded === '[EMAIL]') return ':email';
      return DYNAMIC_SEGMENT.some((re) => re.test(decoded)) ? ':id' : seg;
    })
    .join('/') || '/';
}

function optText(v: unknown, re: RegExp): string | null {
  return typeof v === 'string' && re.test(v) ? v : null;
}

function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function count(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 100000) : 0;
}

export interface ParsedReplayChunk {
  sessionId: string;
  seq: number;
  mode: 'session' | 'buffer';
  /** Page when the chunk was cut (the latest one). */
  page: string | null;
  /** Pages in visit order (earliest first): Meta hrefs and navigation markers, then the SDK list. */
  pages: string[];
  subjectId: string | null;
  userId: string | null;
  environment: string | null;
  release: string | null;
  app: string | null;
  viewport: { w: number; h: number } | null;
  startedAt: Date;
  endedAt: Date;
  eventCount: number;
  errors: number;
  networkErrors: number;
  traceIds: string[];
  /** Pages (paths and route names) for which this chunk holds a full DOM snapshot. */
  snapshotPages: string[];
}

/** rrweb EventType: DomContentLoaded 0, Load 1, FullSnapshot 2, IncrementalSnapshot 3, Meta 4, Custom 5, Plugin 6. */
export const RRWEB_FULL_SNAPSHOT = 2;
export const RRWEB_META = 4;
export const RRWEB_CUSTOM = 5;

/** Decompress (bounded) and JSON-parse a stored or uploaded chunk. */
export function decodeChunk(body: Buffer, maxRawBytes: number): any {
  if (!Buffer.isBuffer(body) || body.length < 18 || body[0] !== 0x1f || body[1] !== 0x8b) {
    throw new ReplayValidationError('body must be a gzip-compressed replay chunk');
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(body, { maxOutputLength: maxRawBytes });
  } catch (err: any) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
      throw new ReplayValidationError('decompressed replay chunk too large', 413);
    }
    throw new ReplayValidationError('invalid gzip data');
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ReplayValidationError('chunk is not valid JSON');
  }
}

/**
 * Validate an uploaded chunk. Throws ReplayValidationError (400 / 413) on bad input.
 * `now` bounds the timestamps: at most 31 days old and 1 day in the future.
 */
export function parseReplayChunk(body: Buffer, limits: ReplayLimits = replayLimits(), now = Date.now()): ParsedReplayChunk {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new ReplayValidationError('empty body');
  if (body.length > limits.maxChunkBytes) throw new ReplayValidationError('replay chunk too large', 413);
  const doc = decodeChunk(body, limits.maxRawBytes);
  if (!doc || typeof doc !== 'object' || doc.v !== 1) throw new ReplayValidationError('unsupported chunk version');
  const sessionId = optText(doc.sessionId, SESSION_ID_RE);
  if (!sessionId) throw new ReplayValidationError('invalid sessionId');
  if (!Number.isInteger(doc.seq) || doc.seq < 0 || doc.seq > 1_000_000) throw new ReplayValidationError('invalid seq');
  if (!Array.isArray(doc.events) || doc.events.length === 0) throw new ReplayValidationError('events required');
  if (doc.events.length > limits.maxEvents) throw new ReplayValidationError('too many events in chunk', 413);

  let minTs = Infinity;
  let maxTs = -Infinity;
  let metaPage: string | null = null;
  const snapshotPages: string[] = [];
  const visits: Array<[number, string]> = []; // [timestamp, page] from Meta hrefs + navigation markers
  for (const ev of doc.events) {
    if (!ev || typeof ev !== 'object' || !Number.isInteger(ev.type) || ev.type < 0 || ev.type > 6) {
      throw new ReplayValidationError('invalid rrweb event');
    }
    const ts = Number(ev.timestamp);
    if (!Number.isFinite(ts)) throw new ReplayValidationError('event timestamp required');
    minTs = Math.min(minTs, ts);
    maxTs = Math.max(maxTs, ts);
    if (ev.type === RRWEB_META) {
      metaPage = normalizePagePath(ev.data?.href);
      if (metaPage) visits.push([ts, metaPage]);
    }
    if (ev.type === RRWEB_CUSTOM && ev.data?.tag === 'navigation') {
      const nav = normalizePagePath(ev.data?.payload?.path);
      if (nav) visits.push([ts, nav]);
    }
    if (ev.type === RRWEB_FULL_SNAPSHOT) {
      const page = metaPage || normalizePagePath(doc.page);
      if (page) {
        for (const key of [page, routeName(page)]) if (!snapshotPages.includes(key) && snapshotPages.length < 40) snapshotPages.push(key);
      }
    }
  }
  if (minTs < now - 31 * 86_400_000 || maxTs > now + 86_400_000) {
    throw new ReplayValidationError('event timestamps out of range');
  }

  // Pages in visit order: what the events show (timestamp order), then the SDK's list
  // (noted in navigation order), then `page` - the page when the chunk was cut, i.e.
  // the LAST one, so it must not come first (a session whose only chunk is the final
  // one would otherwise start on its last page).
  visits.sort((a, b) => a[0] - b[0]);
  const pages: string[] = [];
  for (const p of [...visits.map((v) => v[1]), ...(Array.isArray(doc.pages) ? doc.pages.slice(0, 20) : []), doc.page]) {
    const n = normalizePagePath(p);
    if (n && !pages.includes(n) && pages.length < 40) pages.push(n);
  }
  const vw = Number(doc.viewport?.w);
  const vh = Number(doc.viewport?.h);
  return {
    sessionId,
    seq: doc.seq,
    mode: doc.mode === 'buffer' ? 'buffer' : 'session',
    page: normalizePagePath(doc.page),
    pages,
    subjectId: optText(doc.subjectId, SUBJECT_RE),
    userId: optText(doc.userId, SUBJECT_RE),
    environment: optText(doc.environment, ENV_NAME_RE),
    release: boundedText(doc.release, 200),
    app: boundedText(doc.app, 100),
    viewport: Number.isInteger(vw) && Number.isInteger(vh) && vw > 0 && vh > 0 && vw < 20000 && vh < 20000 ? { w: vw, h: vh } : null,
    startedAt: new Date(minTs),
    endedAt: new Date(maxTs),
    eventCount: doc.events.length,
    errors: count(doc.errors),
    networkErrors: count(doc.networkErrors),
    traceIds: (Array.isArray(doc.traceIds) ? doc.traceIds : []).filter((t: unknown) => typeof t === 'string' && TRACE_RE.test(t)).slice(0, 50),
    snapshotPages,
  };
}

/**
 * From a decoded chunk, the Meta + FullSnapshot pair for `page` (path or route name;
 * any page when omitted). Returns null when the chunk has none.
 */
export function findFullSnapshot(doc: any, page?: string | null): { meta: any; snapshot: any; page: string | null } | null {
  const events: any[] = Array.isArray(doc?.events) ? doc.events : [];
  let meta: any = null;
  let metaPage: string | null = null;
  for (const ev of events) {
    if (ev?.type === RRWEB_META) {
      meta = ev;
      metaPage = normalizePagePath(ev.data?.href);
    } else if (ev?.type === RRWEB_FULL_SNAPSHOT) {
      const p = metaPage || normalizePagePath(doc.page);
      if (!page || (p && (p === page || routeName(p) === page))) return { meta, snapshot: ev, page: p };
    }
  }
  return null;
}
