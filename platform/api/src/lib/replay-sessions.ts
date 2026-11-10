/**
 * Session replay metadata and lifecycle (#40): store a chunk (object + rows),
 * list/get sessions, find the first full snapshot of a page, retention cleanup
 * and GDPR subject delete. Tables: replay_sessions, replay_chunks (migration
 * 1799000000040).
 */
import type { DataSource } from 'typeorm';
import { mergeRetention } from './privacy-settings';
import { decodeChunk, findFullSnapshot, ParsedReplayChunk, ReplayLimits, ReplayValidationError } from './replay-ingest';
import { ReplayObjectStore, replayChunkKey, replaySessionPrefix } from './replay-store';
import { snapshotToHtml } from './replay-snapshot-html';

type Queryable = Pick<DataSource, 'query'>;

const MAX_PAGES = 50;
const MAX_TRACES = 200;

function mergeList(current: unknown, extra: string[], max: number): string[] {
  const out = Array.isArray(current) ? current.filter((v) => typeof v === 'string') : [];
  for (const v of extra) if (!out.includes(v) && out.length < max) out.push(v);
  return out;
}

export interface StoreChunkResult {
  duplicate: boolean;
  objectKey: string;
}

/**
 * Persist one validated chunk: object first (`replays/<project>/<session>/<seq>.json.gz`),
 * then the session aggregate and the chunk row. Re-sent chunks (same seq) are
 * acknowledged without being stored twice. Enforces per-session chunk/byte limits.
 */
export async function storeReplayChunk(
  ds: Queryable,
  store: ReplayObjectStore,
  opts: {
    projectId: string;
    chunk: ParsedReplayChunk;
    body: Buffer;
    userAgent?: string | null;
    environment?: string | null;
    limits: ReplayLimits;
  },
): Promise<StoreChunkResult> {
  const { projectId, chunk, body, limits } = opts;
  const objectKey = replayChunkKey(projectId, chunk.sessionId, chunk.seq);
  const existing = await ds.query(
    `SELECT chunk_count, bytes, pages, trace_ids FROM replay_sessions WHERE project_id = $1 AND session_id = $2`,
    [projectId, chunk.sessionId],
  );
  const row = existing?.[0];
  if (row) {
    const dup = await ds.query(
      `SELECT 1 FROM replay_chunks WHERE project_id = $1 AND session_id = $2 AND seq = $3`,
      [projectId, chunk.sessionId, chunk.seq],
    );
    if (dup?.length) return { duplicate: true, objectKey };
    if (Number(row.chunk_count) >= limits.maxChunksPerSession) throw new ReplayValidationError('session chunk limit reached', 413);
    if (Number(row.bytes) + body.length > limits.maxSessionBytes) throw new ReplayValidationError('session size limit reached', 413);
  }

  await store.put(objectKey, body);

  const pages = mergeList(row?.pages, chunk.pages, MAX_PAGES);
  const traces = mergeList(row?.trace_ids, chunk.traceIds, MAX_TRACES);
  const environment = opts.environment || chunk.environment;
  const userAgent = opts.userAgent ? String(opts.userAgent).slice(0, 512) : null;
  await ds.query(
    `INSERT INTO replay_sessions (project_id, session_id, environment, release, app, user_id, subject_id, user_agent,
        first_page, pages, trace_ids, started_at, ended_at, duration_ms, chunk_count, event_count, bytes,
        error_count, network_error_count, viewport_width, viewport_height)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,
        GREATEST(0, (EXTRACT(EPOCH FROM ($13::timestamptz - $12::timestamptz)) * 1000)::bigint),
        1,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (project_id, session_id) DO UPDATE SET
        environment = COALESCE(replay_sessions.environment, EXCLUDED.environment),
        release = COALESCE(EXCLUDED.release, replay_sessions.release),
        app = COALESCE(replay_sessions.app, EXCLUDED.app),
        user_id = COALESCE(EXCLUDED.user_id, replay_sessions.user_id),
        subject_id = COALESCE(replay_sessions.subject_id, EXCLUDED.subject_id),
        user_agent = COALESCE(replay_sessions.user_agent, EXCLUDED.user_agent),
        first_page = CASE WHEN $20 = 0 THEN EXCLUDED.first_page ELSE COALESCE(replay_sessions.first_page, EXCLUDED.first_page) END,
        pages = EXCLUDED.pages,
        trace_ids = EXCLUDED.trace_ids,
        started_at = LEAST(replay_sessions.started_at, EXCLUDED.started_at),
        ended_at = GREATEST(replay_sessions.ended_at, EXCLUDED.ended_at),
        duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM (GREATEST(replay_sessions.ended_at, EXCLUDED.ended_at)
          - LEAST(replay_sessions.started_at, EXCLUDED.started_at))) * 1000)::bigint),
        chunk_count = replay_sessions.chunk_count + 1,
        event_count = replay_sessions.event_count + EXCLUDED.event_count,
        bytes = replay_sessions.bytes + EXCLUDED.bytes,
        error_count = replay_sessions.error_count + EXCLUDED.error_count,
        network_error_count = replay_sessions.network_error_count + EXCLUDED.network_error_count,
        viewport_width = COALESCE(replay_sessions.viewport_width, EXCLUDED.viewport_width),
        viewport_height = COALESCE(replay_sessions.viewport_height, EXCLUDED.viewport_height),
        updated_at = now()`,
    [
      projectId, chunk.sessionId, environment, chunk.release, chunk.app, chunk.userId, chunk.subjectId, userAgent,
      chunk.page || chunk.pages[0] || null, JSON.stringify(pages), JSON.stringify(traces),
      chunk.startedAt.toISOString(), chunk.endedAt.toISOString(),
      chunk.eventCount, body.length, chunk.errors, chunk.networkErrors,
      chunk.viewport?.w ?? null, chunk.viewport?.h ?? null, chunk.seq,
    ],
  );
  await ds.query(
    `INSERT INTO replay_chunks (project_id, session_id, seq, object_key, bytes, event_count, started_at, ended_at, snapshot_pages)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (project_id, session_id, seq) DO NOTHING`,
    [projectId, chunk.sessionId, chunk.seq, objectKey, body.length, chunk.eventCount,
      chunk.startedAt.toISOString(), chunk.endedAt.toISOString(), JSON.stringify(chunk.snapshotPages)],
  );
  return { duplicate: false, objectKey };
}

export interface ReplayListFilters {
  page?: string;
  hasErrors?: boolean;
  minDurationMs?: number;
  maxDurationMs?: number;
  userId?: string;
  environment?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const LIST_COLUMNS = `session_id, environment, release, app, user_id, user_agent, first_page, pages, trace_ids,
  started_at, ended_at, duration_ms, chunk_count, event_count, bytes, error_count, network_error_count,
  viewport_width, viewport_height`;

/** Newest first; filters: page (substring of any visited path), errors, duration, user, environment, time. */
export async function listReplaySessions(ds: Queryable, projectId: string, f: ReplayListFilters = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(f.limit ?? 50)));
  const offset = Math.max(0, Math.min(100000, Math.floor(f.offset ?? 0)));
  return ds.query(
    `SELECT ${LIST_COLUMNS} FROM replay_sessions WHERE project_id = $1
      AND ($2::text IS NULL OR pages::text ILIKE '%' || $2 || '%')
      AND ($3::boolean IS NULL OR ($3 AND error_count > 0) OR (NOT $3 AND error_count = 0))
      AND ($4::bigint IS NULL OR duration_ms >= $4)
      AND ($5::bigint IS NULL OR duration_ms <= $5)
      AND ($6::text IS NULL OR user_id = $6)
      AND ($7::text IS NULL OR environment = $7)
      AND ($8::timestamptz IS NULL OR started_at >= $8)
      AND ($9::timestamptz IS NULL OR started_at <= $9)
      ORDER BY started_at DESC LIMIT $10 OFFSET $11`,
    [
      projectId,
      f.page ? likeEscape(f.page.slice(0, 200)) : null,
      typeof f.hasErrors === 'boolean' ? f.hasErrors : null,
      Number.isFinite(f.minDurationMs) ? f.minDurationMs : null,
      Number.isFinite(f.maxDurationMs) ? f.maxDurationMs : null,
      f.userId || null,
      f.environment || null,
      f.from ? f.from.toISOString() : null,
      f.to ? f.to.toISOString() : null,
      limit,
      offset,
    ],
  );
}

/** Session row, ordered chunk list and #41 errors that carry this replay id. */
export async function getReplaySession(ds: Queryable, projectId: string, sessionId: string) {
  const rows = await ds.query(`SELECT ${LIST_COLUMNS} FROM replay_sessions WHERE project_id = $1 AND session_id = $2`, [projectId, sessionId]);
  if (!rows?.length) return null;
  const chunks = await ds.query(
    `SELECT seq, bytes, event_count, started_at, ended_at FROM replay_chunks WHERE project_id = $1 AND session_id = $2 ORDER BY seq ASC`,
    [projectId, sessionId],
  );
  let errors: any[] = [];
  try {
    errors = await ds.query(
      `SELECT e.id, e.issue_id, e.received_at, i.title, e.payload->>'type' AS type, e.payload->>'message' AS message,
          e.payload->>'traceId' AS trace_id, e.payload->>'release' AS release
        FROM error_events e JOIN error_issues i ON i.id = e.issue_id
        WHERE e.project_id = $1 AND e.payload->>'replayId' = $2 ORDER BY e.received_at ASC LIMIT 100`,
      [projectId, sessionId],
    );
  } catch {
    errors = []; // error tracking (#41) tables absent: replay still plays
  }
  return { session: rows[0], chunks, errors };
}

export async function getReplayChunkKey(ds: Queryable, projectId: string, sessionId: string, seq: number): Promise<string | null> {
  const rows = await ds.query(
    `SELECT object_key FROM replay_chunks WHERE project_id = $1 AND session_id = $2 AND seq = $3`,
    [projectId, sessionId, seq],
  );
  return rows?.[0]?.object_key ?? null;
}

export interface ReplaySnapshot {
  sessionId: string;
  seq: number;
  page: string | null;
  timestamp: number;
  width: number | null;
  height: number | null;
  /** Inert HTML of the DOM snapshot (render in `<iframe sandbox srcdoc>`). */
  html: string;
  /** rrweb Meta + FullSnapshot events (for an rrweb-based renderer). */
  events: any[];
}

/**
 * First full DOM snapshot of `page` (path or route name, e.g. `/orders/:id`) in a
 * session, or in the most recent session that has one when sessionId is `latest`.
 * Without `page`, the first snapshot of the session.
 */
export async function getReplaySnapshot(
  ds: Queryable,
  store: ReplayObjectStore,
  opts: { projectId: string; sessionId: string | 'latest'; page?: string | null; maxRawBytes: number },
): Promise<ReplaySnapshot | null> {
  const latest = opts.sessionId === 'latest';
  const page = opts.page || null;
  const rows = await ds.query(
    `SELECT session_id, seq, object_key FROM replay_chunks
      WHERE project_id = $1 AND ($2::text IS NULL OR session_id = $2)
        AND (CASE WHEN $3::text IS NULL THEN snapshot_pages <> '[]'::jsonb ELSE snapshot_pages ? $3 END)
      ORDER BY ${latest ? 'received_at DESC, seq ASC' : 'seq ASC'} LIMIT 5`,
    [opts.projectId, latest ? null : opts.sessionId, page],
  );
  for (const row of rows || []) {
    const body = await store.get(row.object_key);
    if (!body) continue;
    let doc: any;
    try {
      doc = decodeChunk(body, opts.maxRawBytes);
    } catch {
      continue;
    }
    const found = findFullSnapshot(doc, page);
    if (!found) continue;
    return {
      sessionId: row.session_id,
      seq: Number(row.seq),
      page: found.page,
      timestamp: Number(found.snapshot.timestamp) || 0,
      width: Number(found.meta?.data?.width) || null,
      height: Number(found.meta?.data?.height) || null,
      html: snapshotToHtml(found.snapshot?.data?.node),
      events: found.meta ? [found.meta, found.snapshot] : [found.snapshot],
    };
  }
  return null;
}

async function deleteSessions(ds: Queryable, store: ReplayObjectStore | null, projectId: string, sessionIds: string[]) {
  let objects = 0;
  let sessions = 0;
  for (const sid of sessionIds) {
    if (store) objects += await store.deletePrefix(replaySessionPrefix(projectId, sid));
    await ds.query(`DELETE FROM replay_sessions WHERE project_id = $1 AND session_id = $2`, [projectId, sid]);
    sessions++;
  }
  return { sessions, objects };
}

/** Delete one session (objects + rows). */
export async function deleteReplaySession(ds: Queryable, store: ReplayObjectStore | null, projectId: string, sessionId: string) {
  return deleteSessions(ds, store, projectId, [sessionId]);
}

/**
 * GDPR (#47): every replay of a subject — by session id, application user id or
 * consent subject id — objects and rows.
 */
export async function deleteReplaysForSubject(
  ds: Queryable,
  store: ReplayObjectStore | null,
  projectId: string,
  subject: { userId?: string | null; sessionId?: string | null },
): Promise<{ sessions: number; objects: number }> {
  if (!subject.userId && !subject.sessionId) return { sessions: 0, objects: 0 };
  const rows = await ds.query(
    `SELECT session_id FROM replay_sessions WHERE project_id = $1
      AND (($2::text IS NOT NULL AND session_id = $2) OR ($3::text IS NOT NULL AND (user_id = $3 OR subject_id = $3)))`,
    [projectId, subject.sessionId || null, subject.userId || null],
  );
  const ids = (rows || []).map((r: any) => String(r.session_id));
  // A session that never reached the metadata table may still have objects.
  if (subject.sessionId && !ids.includes(subject.sessionId)) ids.push(subject.sessionId);
  return deleteSessions(ds, store, projectId, ids);
}

/**
 * Retention (#47 per-project `retentionDays.replays`, default 7): delete sessions
 * that ended before the cutoff. Bounded per run; the hourly leader job repeats.
 * The bucket lifecycle rule is the backstop for orphaned objects.
 */
export async function runReplayRetention(
  ds: Queryable,
  store: ReplayObjectStore | null,
  now: number = Date.now(),
  batch = 500,
): Promise<{ sessions: number; objects: number }> {
  const projects = await ds.query(`SELECT DISTINCT project_id FROM replay_sessions`);
  if (!projects?.length) return { sessions: 0, objects: 0 };
  const ids = projects.map((p: any) => String(p.project_id));
  const settings = await ds.query(
    `SELECT project_id, retention_days FROM telemetry_privacy_settings WHERE project_id = ANY($1::uuid[])`,
    [ids],
  ).catch(() => [] as any[]);
  const byProject: Record<string, any> = Object.fromEntries((settings || []).map((s: any) => [String(s.project_id), s.retention_days]));
  let sessions = 0;
  let objects = 0;
  for (const projectId of ids) {
    const days = mergeRetention(byProject[projectId] || {}).replays;
    const cutoff = new Date(now - days * 86_400_000).toISOString();
    const expired = await ds.query(
      `SELECT session_id FROM replay_sessions WHERE project_id = $1 AND ended_at < $2 ORDER BY ended_at ASC LIMIT $3`,
      [projectId, cutoff, batch],
    );
    const r = await deleteSessions(ds, store, projectId, (expired || []).map((e: any) => String(e.session_id)));
    sessions += r.sessions;
    objects += r.objects;
  }
  return { sessions, objects };
}
