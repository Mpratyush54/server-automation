import { gzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import {
  normalizePagePath,
  parseReplayChunk,
  replayIngestEnabled,
  replayLimits,
  ReplayValidationError,
  routeName,
} from '../../../src/lib/replay-ingest';
import { replayChunkKey } from '../../../src/lib/replay-store';
import { MemoryReplayStore } from '../../helpers/memory-replay-store';
import {
  deleteReplaysForSubject,
  getReplaySession,
  getReplaySnapshot,
  listReplaySessions,
  runReplayRetention,
  storeReplayChunk,
} from '../../../src/lib/replay-sessions';
import { snapshotToHtml } from '../../../src/lib/replay-snapshot-html';
import { FakeReplayDb } from '../../helpers/fake-replay-db';

const P = '11111111-1111-4111-8111-111111111111';
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const SID = 'a1b2c3d4-0000-4000-8000-000000000001';

const SNAPSHOT_NODE = {
  type: 0,
  childNodes: [
    { type: 1, name: 'html' },
    {
      type: 2, tagName: 'html', attributes: {}, childNodes: [
        { type: 2, tagName: 'head', attributes: {}, childNodes: [
          { type: 2, tagName: 'style', attributes: { _cssText: 'body{color:red}</style><script>x</script>' }, childNodes: [] },
          { type: 2, tagName: 'script', attributes: {}, childNodes: [{ type: 3, textContent: 'alert(1)' }] },
        ] },
        { type: 2, tagName: 'body', attributes: { onload: 'alert(1)', class: 'app' }, childNodes: [
          { type: 2, tagName: 'a', attributes: { href: 'javascript:alert(1)', title: 'x"y' }, childNodes: [{ type: 3, textContent: '<b>hi</b>' }] },
          { type: 2, tagName: 'input', attributes: { value: '*****', type: 'password' }, childNodes: [] },
          { type: 2, tagName: 'div', attributes: { class: 'platform-block', rr_width: '100px', rr_height: '20px' }, childNodes: [] },
          { type: 2, tagName: 'iframe', attributes: { src: 'https://evil.test' }, childNodes: [] },
        ] },
      ],
    },
  ],
};

function events(opts: { t0?: number; page?: string; full?: boolean; n?: number } = {}) {
  const t0 = opts.t0 ?? NOW - 60_000;
  const out: any[] = [];
  if (opts.full !== false) {
    out.push({ type: 4, timestamp: t0, data: { href: `https://app.example.test${opts.page || '/orders/42'}?token=x`, width: 1280, height: 720 } });
    out.push({ type: 2, timestamp: t0 + 1, data: { node: SNAPSHOT_NODE, initialOffset: { top: 0, left: 0 } } });
  }
  for (let i = 0; i < (opts.n ?? 3); i++) out.push({ type: 3, timestamp: t0 + 10 + i, data: { source: 1 } });
  return out;
}

function envelope(extra: Record<string, unknown> = {}, evs = events()) {
  return {
    v: 1, sessionId: SID, seq: 0, mode: 'session', page: '/orders/42', pages: ['/orders/42'], subjectId: 'anon-1234abcd',
    userId: 'user-7', environment: 'production', release: '1.2.3', app: 'web', viewport: { w: 1280, h: 720 },
    errors: 0, networkErrors: 0, traceIds: [], events: evs, ...extra,
  };
}

const gz = (doc: unknown) => gzipSync(Buffer.from(JSON.stringify(doc)));
const limits = replayLimits({});

describe('replay chunk validation', () => {
  it('parses a valid chunk and derives timestamps and snapshot pages', () => {
    const c = parseReplayChunk(gz(envelope()), limits, NOW);
    expect(c.sessionId).toBe(SID);
    expect(c.seq).toBe(0);
    expect(c.eventCount).toBe(5);
    expect(c.startedAt.getTime()).toBe(NOW - 60_000);
    expect(c.endedAt.getTime()).toBe(NOW - 60_000 + 12);
    expect(c.snapshotPages).toEqual(['/orders/42', '/orders/:id']);
    expect(c.userId).toBe('user-7');
    expect(c.viewport).toEqual({ w: 1280, h: 720 });
  });

  it('rejects non-gzip, bad JSON, bad ids, bad events and stale timestamps (400)', () => {
    const bad = (body: Buffer) => {
      try { parseReplayChunk(body, limits, NOW); } catch (e) { return e as ReplayValidationError; }
      throw new Error('accepted');
    };
    expect(bad(Buffer.from(JSON.stringify(envelope()))).status).toBe(400);
    expect(bad(gzipSync(Buffer.from('{nope'))).message).toMatch(/JSON/);
    expect(bad(gz(envelope({ v: 2 }))).status).toBe(400);
    expect(bad(gz(envelope({ sessionId: '../../etc' }))).message).toMatch(/sessionId/);
    expect(bad(gz(envelope({ seq: -1 }))).message).toMatch(/seq/);
    expect(bad(gz(envelope({ events: [] }))).message).toMatch(/events/);
    expect(bad(gz(envelope({ events: [{ type: 99, timestamp: NOW }] }))).message).toMatch(/rrweb/);
    expect(bad(gz(envelope({}, events({ t0: NOW - 40 * 86_400_000 })))).message).toMatch(/range/);
  });

  it('enforces compressed and decompressed size limits (413), including gzip bombs', () => {
    const small = { ...limits, maxChunkBytes: 64 * 1024, maxRawBytes: 256 * 1024 };
    const noisy = randomBytes(80 * 1024).toString('base64');
    const tooBig = gz(envelope({}, [...events(), { type: 5, timestamp: NOW, data: { tag: 'x', payload: noisy } }]));
    expect(() => parseReplayChunk(tooBig, small, NOW)).toThrow(expect.objectContaining({ status: 413 }));
    const bomb = gzipSync(Buffer.alloc(10 * 1024 * 1024, 0x20)); // 10 MiB of spaces, ~10 KiB compressed
    expect(bomb.length).toBeLessThan(small.maxChunkBytes);
    expect(() => parseReplayChunk(bomb, small, NOW)).toThrow(expect.objectContaining({ status: 413 }));
    const many = gz(envelope({}, Array.from({ length: 101 }, (_, i) => ({ type: 3, timestamp: NOW - 1000 + i, data: {} }))));
    expect(() => parseReplayChunk(many, { ...limits, maxEvents: 100 }, NOW)).toThrow(expect.objectContaining({ status: 413 }));
  });

  // Regression (#40 Playwright): a session whose only chunk is the final one (sent on page hide)
  // started on its LAST page because `page` (the page when the chunk was cut) was put first.
  it('derives pages in visit order from Meta hrefs and navigation markers, not the current page first', () => {
    const t0 = NOW - 60_000;
    const evs = [
      { type: 4, timestamp: t0, data: { href: 'https://app.example.test/?utm=x', width: 1, height: 1 } },
      { type: 2, timestamp: t0 + 1, data: { node: SNAPSHOT_NODE, initialOffset: { top: 0, left: 0 } } },
      // out of timestamp order on purpose: sorted by time
      { type: 5, timestamp: t0 + 900, data: { tag: 'navigation', payload: { path: '/checkout', route: '/checkout' } } },
      { type: 5, timestamp: t0 + 400, data: { tag: 'navigation', payload: { path: '/orders/42', route: '/orders/:id' } } },
      { type: 5, timestamp: t0 + 500, data: { tag: 'network', payload: { url: 'https://api.test/x' } } },
      { type: 3, timestamp: t0 + 950, data: { source: 1 } },
    ];
    const c = parseReplayChunk(gz(envelope({ page: '/checkout', pages: ['/', '/orders/42', '/checkout'] }, evs)), limits, NOW);
    expect(c.pages).toEqual(['/', '/orders/42', '/checkout']);
    expect(c.page).toBe('/checkout');
    // without the SDK list, the events alone give the order; `page` comes last
    const bare = parseReplayChunk(gz(envelope({ page: '/checkout', pages: undefined }, evs)), limits, NOW);
    expect(bare.pages).toEqual(['/', '/orders/42', '/checkout']);
    const noEvents = parseReplayChunk(gz(envelope({ page: '/b', pages: ['/a', '/b'] }, events({ full: false }))), limits, NOW);
    expect(noEvents.pages).toEqual(['/a', '/b']);
  });

  it('normalises page keys (no query, no e-mails) and route names', () => {
    expect(normalizePagePath('https://u:p@x.test/a/b?q=1#h')).toBe('/a/b');
    expect(normalizePagePath('/users/jane@example.com/x')).toBe('/users/[EMAIL]/x');
    expect(normalizePagePath('relative')).toBeNull();
    expect(routeName('/orders/42/items/0f9e8d7c-1a2b-4c3d-8e9f-001122334455')).toBe('/orders/:id/items/:id');
  });

  it('is on with the full profile unless switched off', () => {
    expect(replayIngestEnabled({})).toBe(false);
    expect(replayIngestEnabled({ PLATFORM_OBSERVABILITY: 'enabled' })).toBe(true);
    expect(replayIngestEnabled({ PLATFORM_OBSERVABILITY: 'enabled', REPLAY_INGEST: 'off' })).toBe(false);
    expect(replayIngestEnabled({ REPLAY_INGEST: 'on' })).toBe(true);
  });
});

describe('replay storage, metadata and lifecycle', () => {
  const store = (db: FakeReplayDb, s: MemoryReplayStore, extra: Record<string, unknown>, evs?: any[]) => {
    const body = gz(envelope(extra, evs));
    return storeReplayChunk(db as any, s, { projectId: P, chunk: parseReplayChunk(body, limits, NOW), body, userAgent: 'Mozilla/5.0 test', limits });
  };

  it('stores objects under replays/<project>/<session>/<seq>.json.gz and aggregates metadata', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    await store(db, s, { seq: 1, page: '/checkout', pages: ['/checkout'], errors: 2, networkErrors: 1, traceIds: ['a'.repeat(32)] },
      events({ t0: NOW - 30_000, full: false }));
    await store(db, s, { seq: 0 });
    expect([...s.objects.keys()].sort()).toEqual([replayChunkKey(P, SID, 0), replayChunkKey(P, SID, 1)]);
    expect(replayChunkKey(P, SID, 0)).toBe(`replays/${P}/${SID}/0.json.gz`);
    const out = await getReplaySession(db as any, P, SID);
    expect(out!.session.chunk_count).toBe(2);
    expect(out!.session.error_count).toBe(2);
    expect(out!.session.network_error_count).toBe(1);
    expect(out!.session.first_page).toBe('/orders/42'); // from seq 0 even though it arrived second
    expect(out!.session.pages).toEqual(['/orders/42', '/checkout']); // visit order: seq 0 started first
    expect(out!.session.trace_ids).toEqual(['a'.repeat(32)]);
    expect(out!.session.user_agent).toBe('Mozilla/5.0 test');
    expect(out!.session.duration_ms).toBe(30_000 + 12);
    expect(out!.chunks.map((c: any) => c.seq)).toEqual([0, 1]); // ordered by seq
    expect(out!.errors).toEqual([]); // #41 tables absent: still plays
  });

  it('a session whose only chunk is the final one starts on its first page', async () => {
    const t0 = NOW - 20_000;
    const finalChunk = [
      { type: 4, timestamp: t0, data: { href: 'https://app.example.test/', width: 1, height: 1 } },
      { type: 2, timestamp: t0 + 1, data: { node: SNAPSHOT_NODE, initialOffset: { top: 0, left: 0 } } },
      { type: 5, timestamp: t0 + 300, data: { tag: 'navigation', payload: { path: '/checkout' } } },
    ];
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    await store(db, s, { seq: 0, page: '/checkout', pages: ['/', '/checkout'] }, finalChunk);
    expect(db.sessions[0].first_page).toBe('/');
    expect(db.sessions[0].pages).toEqual(['/', '/checkout']);
    await store(db, s, { seq: 1, page: '/done', pages: ['/done'] }, events({ t0: NOW - 10_000, page: '/done' }));
    expect(db.sessions[0].pages).toEqual(['/', '/checkout', '/done']); // later chunk appends

    // seq 0 arriving after seq 1 still provides the first page and goes first
    const db2 = new FakeReplayDb();
    await store(db2, s, { seq: 1, page: '/done', pages: ['/done'] }, events({ t0: NOW - 10_000, page: '/done' }));
    await store(db2, s, { seq: 0, page: '/checkout', pages: ['/', '/checkout'] }, finalChunk);
    expect(db2.sessions[0].first_page).toBe('/');
    expect(db2.sessions[0].pages).toEqual(['/', '/checkout', '/done']);
  });

  // Concurrent chunks of one session (keepalive re-send on page hide, parallel tabs of the
  // uploader) used to read pages/counters, await the object write and then overwrite them.
  it('stores concurrent chunks of one session atomically: no lost pages, limits hold, duplicates once', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    const pages = ['/a', '/b', '/c', '/d', '/e', '/f'];
    const results = await Promise.allSettled(pages.map((pg, i) => {
      const body = gz(envelope({ seq: i, page: pg, pages: [pg] }, events({ t0: NOW - 60_000 + i * 1000, page: pg })));
      return storeReplayChunk(db as any, s, { projectId: P, chunk: parseReplayChunk(body, limits, NOW), body, limits: { ...limits, maxChunksPerSession: 4 } });
    }));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(4);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => r.reason.status)).toEqual([413, 413]);
    const row = db.sessions[0];
    expect(row.chunk_count).toBe(4);
    expect(db.chunks.length).toBe(4);
    const stored = db.chunks.map((c) => pages[c.seq]);
    expect([...row.pages].sort()).toEqual([...stored].sort()); // every stored chunk's page kept
    expect(row.pages).toEqual(pages.filter((pg) => stored.includes(pg))); // in visit order
    expect(db.transactions).toBeGreaterThanOrEqual(4);

    const db2 = new FakeReplayDb();
    const twice = await Promise.all([0, 0, 0].map(() => {
      const body = gz(envelope({ seq: 0 }));
      return storeReplayChunk(db2 as any, s, { projectId: P, chunk: parseReplayChunk(body, limits, NOW), body, limits });
    }));
    expect(twice.filter((r) => r.duplicate).length).toBe(2);
    expect(db2.sessions[0].chunk_count).toBe(1);
    expect(db2.sessions[0].bytes).toBe(db2.chunks[0].bytes);
  });

  it('acknowledges duplicate chunks once and enforces per-session limits', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    expect((await store(db, s, { seq: 0 })).duplicate).toBe(false);
    expect((await store(db, s, { seq: 0 })).duplicate).toBe(true);
    expect(db.sessions[0].chunk_count).toBe(1);
    const tight = { ...limits, maxChunksPerSession: 1 };
    const body = gz(envelope({ seq: 1 }));
    await expect(storeReplayChunk(db as any, s, { projectId: P, chunk: parseReplayChunk(body, limits, NOW), body, limits: tight }))
      .rejects.toMatchObject({ status: 413 });
  });

  it('lists with page / error / duration filters, newest first', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    await store(db, s, { sessionId: 'sess-aaaa-0001', errors: 1 }, events({ t0: NOW - 50_000 }));
    await store(db, s, { sessionId: 'sess-bbbb-0002', page: '/pricing', pages: ['/pricing'] }, events({ t0: NOW - 10_000, page: '/pricing' }));
    const ids = (rows: any[]) => rows.map((r) => r.session_id);
    expect(ids(await listReplaySessions(db as any, P))).toEqual(['sess-bbbb-0002', 'sess-aaaa-0001']);
    expect(ids(await listReplaySessions(db as any, P, { page: 'pric' }))).toEqual(['sess-bbbb-0002']);
    expect(ids(await listReplaySessions(db as any, P, { hasErrors: true }))).toEqual(['sess-aaaa-0001']);
    expect(ids(await listReplaySessions(db as any, P, { minDurationMs: 1000 }))).toEqual([]);
    expect(ids(await listReplaySessions(db as any, '22222222-2222-4222-8222-222222222222'))).toEqual([]);
  });

  it('returns the first full snapshot of a page as inert HTML (by path, route or latest)', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    await store(db, s, { seq: 0 });
    const snap = await getReplaySnapshot(db as any, s, { projectId: P, sessionId: SID, page: '/orders/:id', maxRawBytes: limits.maxRawBytes });
    expect(snap).toMatchObject({ sessionId: SID, seq: 0, page: '/orders/42', width: 1280, height: 720 });
    expect(snap!.events.map((e) => e.type)).toEqual([4, 2]);
    expect(snap!.html).toContain('Content-Security-Policy');
    expect(snap!.html).not.toMatch(/<script|alert\(1\)|onload|javascript:|<iframe|<\/style><script/i);
    expect(snap!.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(snap!.html).toContain('background:#d4d4d8');
    const latest = await getReplaySnapshot(db as any, s, { projectId: P, sessionId: 'latest', page: '/orders/42', maxRawBytes: limits.maxRawBytes });
    expect(latest?.sessionId).toBe(SID);
    expect(await getReplaySnapshot(db as any, s, { projectId: P, sessionId: SID, page: '/nope', maxRawBytes: limits.maxRawBytes })).toBeNull();
  });

  it('retention deletes sessions past the project retention (objects + rows)', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    await store(db, s, { sessionId: 'sess-old-00001' }, events({ t0: NOW - 10 * 86_400_000 }));
    await store(db, s, { sessionId: 'sess-new-00002' }, events({ t0: NOW - 60_000 }));
    // default replay retention is 7 days
    expect(await runReplayRetention(db as any, s, NOW)).toEqual({ sessions: 1, objects: 1 });
    expect(db.sessions.map((x) => x.session_id)).toEqual(['sess-new-00002']);
    expect([...s.objects.keys()].every((k) => k.includes('sess-new-00002'))).toBe(true);
    db.retention.set(P, { replays: 30 });
    await store(db, s, { sessionId: 'sess-mid-00003' }, events({ t0: NOW - 20 * 86_400_000 }));
    expect((await runReplayRetention(db as any, s, NOW)).sessions).toBe(0);
  });

  it('GDPR delete removes replays by user id, consent subject or session id', async () => {
    const db = new FakeReplayDb();
    const s = new MemoryReplayStore();
    await store(db, s, { sessionId: 'sess-user-0001', userId: 'user-9' });
    await store(db, s, { sessionId: 'sess-anon-0002', userId: undefined, subjectId: 'anon-77777777' });
    await store(db, s, { sessionId: 'sess-keep-0003', userId: 'someone-else' });
    expect(await deleteReplaysForSubject(db as any, s, P, { userId: 'user-9' })).toEqual({ sessions: 1, objects: 1 });
    expect((await deleteReplaysForSubject(db as any, s, P, { userId: 'anon-77777777' })).sessions).toBe(1);
    expect(db.sessions.map((x) => x.session_id)).toEqual(['sess-keep-0003']);
    expect((await deleteReplaysForSubject(db as any, s, P, { sessionId: 'sess-keep-0003' })).objects).toBe(1);
    expect(s.objects.size).toBe(0);
  });

  it('snapshot HTML never contains active content', () => {
    const html = snapshotToHtml({ type: 2, tagName: 'div', attributes: { onclick: 'x()', style: 'background:url(javascript:x)' }, childNodes: [
      { type: 2, tagName: 'form', attributes: { action: 'https://evil.test' }, childNodes: [] },
      { type: 2, tagName: 'meta', attributes: { 'http-equiv': 'refresh', content: '0;url=https://evil.test' }, childNodes: [] },
      { type: 2, tagName: 'img', attributes: { src: 'data:text/html,<script>', alt: 'a' }, childNodes: [] },
    ] });
    expect(html).not.toMatch(/onclick|javascript:|action=|http-equiv="refresh"|data:text/);
  });
});
