/**
 * In-memory stand-in for the replay_sessions / replay_chunks SQL used by
 * lib/replay-sessions.ts (unit tests without Postgres). Each statement is matched
 * by a distinctive fragment and emulated with the same parameters; unknown SQL
 * throws so a changed query cannot silently pass. The real SQL is exercised by
 * tests/integration/replay.db.test.ts against Postgres (MIGRATION_TEST_PG_HOST).
 */
export interface FakeSession {
  project_id: string;
  session_id: string;
  environment: string | null;
  release: string | null;
  app: string | null;
  user_id: string | null;
  subject_id: string | null;
  user_agent: string | null;
  first_page: string | null;
  pages: string[];
  trace_ids: string[];
  started_at: Date;
  ended_at: Date;
  duration_ms: number;
  chunk_count: number;
  event_count: number;
  bytes: number;
  error_count: number;
  network_error_count: number;
  viewport_width: number | null;
  viewport_height: number | null;
}

export interface FakeChunk {
  project_id: string;
  session_id: string;
  seq: number;
  object_key: string;
  bytes: number;
  event_count: number;
  started_at: Date;
  ended_at: Date;
  snapshot_pages: string[];
  received_at: Date;
}

/** The real list/get queries never select subject_id (the consent subject stays server-side). */
function listColumns(r: FakeSession) {
  const { subject_id: _s, project_id: _p, ...rest } = r;
  return rest;
}

export class FakeReplayDb {
  sessions: FakeSession[] = [];
  chunks: FakeChunk[] = [];
  retention = new Map<string, Record<string, number>>();
  errorEvents: any[] | null = null; // null = table missing
  queries: string[] = [];
  private clock = 0;
  private locks = new Map<string, Promise<void>>();
  transactions = 0;

  /**
   * Emulates `DataSource.transaction` + `pg_advisory_xact_lock`: the lock taken inside a
   * transaction blocks other transactions asking for the same key until it ends.
   * (No rollback: the code under test throws before writing.)
   */
  async transaction<T>(run: (tx: { query: (sql: string, p?: any[]) => Promise<any> }) => Promise<T>): Promise<T> {
    this.transactions++;
    const held: Array<() => void> = [];
    const tx = {
      query: async (sql: string, p: any[] = []) => {
        if (/^\s*SELECT pg_advisory_xact_lock\(hashtextextended\(\$1,0\)\)\s*$/.test(sql)) {
          this.queries.push(sql.trim());
          const key = String(p[0]);
          const prev = this.locks.get(key) ?? Promise.resolve();
          let release!: () => void;
          const mine = new Promise<void>((r) => (release = r));
          this.locks.set(key, prev.then(() => mine));
          await prev;
          held.push(release);
          return [{ pg_advisory_xact_lock: '' }];
        }
        return this.query(sql, p);
      },
    };
    try {
      return await run(tx);
    } finally {
      held.forEach((r) => r());
    }
  }

  async query(sql: string, p: any[] = []): Promise<any> {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.queries.push(s);
    const sess = (pid: string, sid: string) => this.sessions.find((x) => x.project_id === pid && x.session_id === sid);
    if (s.startsWith('SELECT chunk_count, bytes, pages, trace_ids, first_page, started_at FROM replay_sessions')) {
      const r = sess(p[0], p[1]);
      return r ? [r] : [];
    }
    if (s.startsWith('SELECT 1 FROM replay_chunks')) {
      return this.chunks.filter((c) => c.project_id === p[0] && c.session_id === p[1] && c.seq === p[2]).map(() => ({ '?column?': 1 }));
    }
    if (s.startsWith('INSERT INTO replay_sessions')) {
      const [pid, sid, env, release, app, user, subject, ua, firstPage, pages, traces, start, end, events, bytes, errors, netErrors, vw, vh] = p;
      const st = new Date(start);
      const en = new Date(end);
      const cur = sess(pid, sid);
      if (!cur) {
        this.sessions.push({
          project_id: pid, session_id: sid, environment: env, release, app, user_id: user, subject_id: subject, user_agent: ua,
          first_page: firstPage, pages: JSON.parse(pages), trace_ids: JSON.parse(traces), started_at: st, ended_at: en,
          duration_ms: Math.max(0, en.getTime() - st.getTime()), chunk_count: 1, event_count: events, bytes,
          error_count: errors, network_error_count: netErrors, viewport_width: vw, viewport_height: vh,
        });
      } else {
        cur.environment = cur.environment ?? env;
        cur.release = release ?? cur.release;
        cur.app = cur.app ?? app;
        cur.user_id = user ?? cur.user_id;
        cur.subject_id = cur.subject_id ?? subject;
        cur.user_agent = cur.user_agent ?? ua;
        cur.first_page = firstPage;
        cur.pages = JSON.parse(pages);
        cur.trace_ids = JSON.parse(traces);
        cur.started_at = new Date(Math.min(cur.started_at.getTime(), st.getTime()));
        cur.ended_at = new Date(Math.max(cur.ended_at.getTime(), en.getTime()));
        cur.duration_ms = cur.ended_at.getTime() - cur.started_at.getTime();
        cur.chunk_count += 1;
        cur.event_count += events;
        cur.bytes += bytes;
        cur.error_count += errors;
        cur.network_error_count += netErrors;
        cur.viewport_width = cur.viewport_width ?? vw;
        cur.viewport_height = cur.viewport_height ?? vh;
      }
      return [];
    }
    if (s.startsWith('INSERT INTO replay_chunks')) {
      const [pid, sid, seq, key, bytes, events, start, end, pages] = p;
      if (!this.chunks.some((c) => c.project_id === pid && c.session_id === sid && c.seq === seq)) {
        this.chunks.push({ project_id: pid, session_id: sid, seq, object_key: key, bytes, event_count: events,
          started_at: new Date(start), ended_at: new Date(end), snapshot_pages: JSON.parse(pages), received_at: new Date(++this.clock) });
      }
      return [];
    }
    if (s.includes('FROM replay_sessions WHERE project_id = $1 AND ($2::text IS NULL OR pages::text ILIKE')) {
      const [pid, page, hasErrors, minD, maxD, user, env, from, to, limit, offset] = p;
      const unescape = (x: string) => x.replace(/\\([\\%_])/g, '$1');
      return this.sessions
        .filter((x) => x.project_id === pid)
        .filter((x) => page === null || JSON.stringify(x.pages).toLowerCase().includes(unescape(page).toLowerCase()))
        .filter((x) => hasErrors === null || (hasErrors ? x.error_count > 0 : x.error_count === 0))
        .filter((x) => minD === null || x.duration_ms >= minD)
        .filter((x) => maxD === null || x.duration_ms <= maxD)
        .filter((x) => user === null || x.user_id === user)
        .filter((x) => env === null || x.environment === env)
        .filter((x) => from === null || x.started_at >= new Date(from))
        .filter((x) => to === null || x.started_at <= new Date(to))
        .sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
        .slice(offset, offset + limit)
        .map(listColumns);
    }
    if (s.includes('FROM replay_sessions WHERE project_id = $1 AND session_id = $2') && s.startsWith('SELECT session_id, environment')) {
      const r = sess(p[0], p[1]);
      return r ? [listColumns(r)] : [];
    }
    if (s.startsWith('SELECT seq, bytes, event_count, started_at, ended_at FROM replay_chunks')) {
      return this.chunks.filter((c) => c.project_id === p[0] && c.session_id === p[1]).sort((a, b) => a.seq - b.seq);
    }
    if (s.includes('FROM error_events e JOIN error_issues')) {
      if (this.errorEvents === null) throw new Error('relation "error_events" does not exist');
      return this.errorEvents.filter((e) => e.project_id === p[0] && e.replayId === p[1]);
    }
    if (s.startsWith('SELECT object_key FROM replay_chunks')) {
      return this.chunks.filter((c) => c.project_id === p[0] && c.session_id === p[1] && c.seq === p[2]);
    }
    if (s.startsWith('SELECT session_id, seq, object_key FROM replay_chunks')) {
      const [pid, sid, page] = p;
      const latest = s.includes('received_at DESC');
      return this.chunks
        .filter((c) => c.project_id === pid && (sid === null || c.session_id === sid))
        .filter((c) => (page === null ? c.snapshot_pages.length > 0 : c.snapshot_pages.includes(page)))
        .sort((a, b) => (latest ? b.received_at.getTime() - a.received_at.getTime() || a.seq - b.seq : a.seq - b.seq))
        .slice(0, 5);
    }
    if (s.startsWith('DELETE FROM replay_sessions WHERE project_id = $1 AND session_id = $2')) {
      this.sessions = this.sessions.filter((x) => !(x.project_id === p[0] && x.session_id === p[1]));
      this.chunks = this.chunks.filter((x) => !(x.project_id === p[0] && x.session_id === p[1])); // ON DELETE CASCADE
      return [];
    }
    if (s.startsWith('SELECT session_id FROM replay_sessions WHERE project_id = $1 AND (($2::text IS NOT NULL')) {
      const [pid, sid, user] = p;
      return this.sessions
        .filter((x) => x.project_id === pid && ((sid !== null && x.session_id === sid) || (user !== null && (x.user_id === user || x.subject_id === user))))
        .map((x) => ({ session_id: x.session_id }));
    }
    if (s.startsWith('SELECT DISTINCT project_id FROM replay_sessions')) {
      return [...new Set(this.sessions.map((x) => x.project_id))].map((project_id) => ({ project_id }));
    }
    if (s.startsWith('SELECT project_id, retention_days FROM telemetry_privacy_settings')) {
      return (p[0] as string[]).filter((id) => this.retention.has(id)).map((id) => ({ project_id: id, retention_days: this.retention.get(id) }));
    }
    if (s.startsWith('SELECT session_id FROM replay_sessions WHERE project_id = $1 AND ended_at < $2')) {
      return this.sessions
        .filter((x) => x.project_id === p[0] && x.ended_at < new Date(p[1]))
        .sort((a, b) => a.ended_at.getTime() - b.ended_at.getTime())
        .slice(0, p[2])
        .map((x) => ({ session_id: x.session_id }));
    }
    throw new Error(`FakeReplayDb: unexpected SQL: ${s.slice(0, 120)}`);
  }
}
