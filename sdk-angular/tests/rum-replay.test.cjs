// Session replay (#40) unit tests (run via `npm test`, which builds first).
// NOTE: identical in sdk-react and sdk-angular (shared rum-replay.ts); keep the copies in sync.
try {
  require('@angular/compiler'); // sdk-angular: JIT for partially compiled Angular packages under Node
} catch {
  /* sdk-react */
}
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const replay = require('../dist/rum-replay');
const rum = require('../dist/rum');

const TELEMETRY = { enabled: true, browserToken: 'plat_ingest_web_abc', replayEndpoint: 'https://api.example.test/api/sdk/replay' };

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

function fakeEnv(o = {}) {
  const listeners = {};
  const calls = [];
  const timers = [];
  let now = o.now ?? 1_700_000_000_000;
  const env = {
    win: {
      document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
      location: { href: 'https://app.example.test/orders/42?token=secret', origin: 'https://app.example.test' },
      innerWidth: 1280,
      innerHeight: 720,
      addEventListener: (t, fn) => ((listeners[t] = listeners[t] || []).push(fn)),
      removeEventListener: (t, fn) => (listeners[t] = (listeners[t] || []).filter((f) => f !== fn)),
    },
    nav: o.nav || {},
    session: o.session || memStorage(),
    local: o.local || memStorage(),
    random: o.random || (() => 0),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (o.respond) return o.respond(url, init);
      if (url.includes('/allowed')) return { status: 200, json: async () => ({ replayAllowed: !!o.serverAllows }) };
      return { status: 202, headers: { get: () => null } };
    },
  };
  return { env, listeners, calls, timers, advance: (ms) => (now += ms) };
}

function fakeRecorder() {
  const state = { configs: [], emit: null, custom: [], snapshots: 0, stopped: false, loads: 0 };
  return {
    state,
    load: async () => {
      state.loads++;
      return {
        gzip: (text) => zlib.gzipSync(Buffer.from(text)),
        startRecorder: (config, emit) => {
          state.configs.push(config);
          state.emit = emit;
          return {
            stop: () => (state.stopped = true),
            addCustomEvent: (tag, payload) => {
              state.custom.push({ tag, payload });
              emit({ type: 5, timestamp: Date.now(), data: { tag, payload } });
            },
            takeFullSnapshot: () => state.snapshots++,
          };
        },
      };
    },
  };
}

const flushMicro = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const uploads = (calls) => calls.filter((c) => c.url.endsWith('/chunks'));
const decode = (call) => JSON.parse(zlib.gunzipSync(Buffer.from(call.init.body)).toString());

test.afterEach(() => replay.stopReplay());

// ------------------------------------------------------------------ masking defaults

test('record options mask every input and block/mask classes by default', () => {
  const o = replay.buildRecordOptions({});
  assert.equal(o.maskAllInputs, true);
  assert.deepEqual(o.maskInputOptions, { password: true });
  assert.equal(o.maskInputFn('hunter2'), '*******');
  assert.ok(o.blockClass.test('platform-block') && o.blockClass.test('rr-block') && !o.blockClass.test('other'));
  assert.ok(o.maskTextClass.test('platform-mask') && o.maskTextClass.test('rr-mask'));
  assert.match(o.blockSelector, /\[data-platform-block\]/);
  assert.equal(o.maskTextSelector, '*'); // every text node goes through maskTextFn
  assert.equal(o.recordCanvas, false);
  assert.equal(o.inlineImages, false);
  assert.equal(o.collectFonts, false);
  assert.equal(o.recordCrossOriginIframes, false);
  assert.equal(o.slimDOMOptions, 'all');
  // maskAllInputs:false still masks passwords
  assert.equal(replay.buildRecordOptions({ maskAllInputs: false }).maskAllInputs, false);
  assert.deepEqual(replay.buildRecordOptions({ maskAllInputs: false }).maskInputOptions, { password: true });
});

test('text masking: pii redacts e-mails/tokens, explicit mask elements are starred, all/none modes', () => {
  const plain = { closest: () => null };
  const masked = { closest: (sel) => (sel.includes('[data-platform-mask]') ? {} : null) };
  const pii = replay.buildRecordOptions({});
  assert.equal(pii.maskTextFn('mail jane@example.com now', plain), 'mail [EMAIL] now');
  assert.doesNotMatch(pii.maskTextFn('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk', plain), /eyJhbGci/);
  assert.equal(pii.maskTextFn('Card 4111', masked), '**** ****');
  const all = replay.buildRecordOptions({ maskText: 'all' });
  assert.equal(all.maskTextFn('Hello world', plain), '***** *****');
  const none = replay.buildRecordOptions({ maskText: 'none', maskTextSelector: '.secret' });
  assert.notEqual(none.maskTextSelector, '*');
  assert.match(none.maskTextSelector, /\[data-platform-mask\]/);
  assert.match(none.maskTextSelector, /\.secret/);
  // invalid custom selector fails closed
  const bad = { closest: () => { throw new Error('bad selector'); } };
  assert.equal(pii.maskTextFn('abc', bad), '***');
});

// ------------------------------------------------------------------ sampling

test('sampling: session / on-error buffer / off, sticky per session', () => {
  assert.equal(replay.decideReplayMode(1, 1, () => 0.99), 'session');
  assert.equal(replay.decideReplayMode(0.1, 1, () => 0.5), 'buffer');
  assert.equal(replay.decideReplayMode(0.1, 0, () => 0.5), 'off');
  assert.equal(replay.decideReplayMode(0, 0, () => 0), 'off');
  const store = memStorage();
  const first = replay.loadReplaySession({ sampleRate: 1 }, store, 1000, () => 0.2);
  const again = replay.loadReplaySession({ sampleRate: 0 }, store, 2000, () => 0.9);
  assert.equal(again.id, first.id);
  assert.equal(again.mode, 'session');
  // idle timeout starts a new session with a new decision
  const later = replay.loadReplaySession({ sampleRate: 0, onErrorSampleRate: 0 }, store, 1000 + replay.REPLAY_IDLE_MS + 1);
  assert.notEqual(later.id, first.id);
  assert.equal(later.mode, 'off');
});

test('sampled-out sessions never download the recorder', async () => {
  const f = fakeEnv({ serverAllows: true });
  const rec = fakeRecorder();
  const skips = [];
  const h = await replay.startReplay({ sampleRate: 0, onErrorSampleRate: 0, requireConsent: false }, TELEMETRY, {}, { env: f.env, load: rec.load, onSkip: (r) => skips.push(r) });
  assert.equal(h, null);
  assert.deepEqual(skips, ['not-sampled']);
  assert.equal(rec.state.loads, 0);
});

// ------------------------------------------------------------------ consent gating

test('no recording before consent when consent is required; setConsent starts it', async () => {
  const f = fakeEnv({ serverAllows: false });
  const rec = fakeRecorder();
  const skips = [];
  const h = await replay.startReplay({ sampleRate: 1 }, TELEMETRY, {}, { env: f.env, load: rec.load, onSkip: (r) => skips.push(r) });
  assert.equal(h, null);
  assert.deepEqual(skips, ['no-consent']);
  assert.equal(rec.state.loads, 0, 'rrweb must not be loaded before consent');
  assert.equal(uploads(f.calls).length, 0);
  const allowed = f.calls.find((c) => c.url.includes('/allowed'));
  assert.match(allowed.url, /subjectId=anon-/);
  assert.equal(allowed.init.headers.Authorization, 'Bearer plat_ingest_web_abc');

  replay.setConsent({ replay: true });
  await flushMicro();
  await flushMicro();
  assert.equal(rec.state.loads, 1);
  assert.ok(replay.getReplay());
  const put = f.calls.find((c) => c.url.endsWith('/consent'));
  assert.equal(put.init.method, 'PUT');
  assert.equal(JSON.parse(put.init.body).replayAllowed, true);
  assert.equal(f.env.local.getItem('platform.consent.replay'), '1');
});

test('server-recorded consent allows recording; server errors fail closed', async () => {
  const ok = fakeEnv({ serverAllows: true });
  const rec = fakeRecorder();
  assert.ok(await replay.startReplay({ sampleRate: 1 }, TELEMETRY, {}, { env: ok.env, load: rec.load }));
  replay.stopReplay();
  const broken = fakeEnv({ respond: async () => { throw new Error('offline'); } });
  const rec2 = fakeRecorder();
  assert.equal(await replay.startReplay({ sampleRate: 1 }, TELEMETRY, {}, { env: broken.env, load: rec2.load }), null);
  assert.equal(rec2.state.loads, 0);
});

test('explicit local "no" wins even without requireConsent; withdrawal stops recording', async () => {
  const f = fakeEnv({ local: memStorage({ 'platform.consent.replay': '0' }) });
  const rec = fakeRecorder();
  assert.equal(await replay.startReplay({ sampleRate: 1, requireConsent: false }, TELEMETRY, {}, { env: f.env, load: rec.load }), null);
  assert.equal(rec.state.loads, 0);
  replay.stopReplay();

  const g = fakeEnv();
  const rec2 = fakeRecorder();
  const h = await replay.startReplay({ sampleRate: 1, requireConsent: false }, TELEMETRY, {}, { env: g.env, load: rec2.load });
  assert.ok(h);
  assert.equal(g.calls.filter((c) => c.url.includes('/allowed')).length, 0);
  replay.setConsent({ replay: false });
  assert.equal(rec2.state.stopped, true);
  assert.equal(replay.getReplay(), null);
  assert.equal(rum.getReplayId(), undefined);
});

test('doNotTrack and missing endpoint/token skip replay', async () => {
  const rec = fakeRecorder();
  const skips = [];
  const dnt = fakeEnv({ nav: { doNotTrack: '1' } });
  await replay.startReplay({ sampleRate: 1, requireConsent: false }, TELEMETRY, {}, { env: dnt.env, load: rec.load, onSkip: (r) => skips.push(r) });
  replay.stopReplay();
  await replay.startReplay({ sampleRate: 1, requireConsent: false }, { enabled: true }, {}, { env: fakeEnv().env, load: rec.load, onSkip: (r) => skips.push(r) });
  replay.stopReplay();
  assert.equal(await replay.startReplay(undefined, TELEMETRY), null);
  assert.deepEqual(skips, ['do-not-track', 'no-endpoint']);
  assert.equal(rec.state.loads, 0);
  // apiBase + SDK token fallback
  assert.equal(replay.replayEndpoint({}, null, { apiBase: 'https://p.example.test/' }), 'https://p.example.test/api/sdk/replay');
  assert.equal(replay.replayEndpoint({}, null, {}), null);
  assert.equal(replay.replayEndpoint({ endpoint: 'javascript:alert(1)' }, null, {}), null);
});

// ------------------------------------------------------------------ recording -> chunks -> upload

test('session mode uploads gzipped, ordered chunks with redacted Meta href and markers', async () => {
  const f = fakeEnv({ serverAllows: true });
  const rec = fakeRecorder();
  const h = await replay.startReplay({ sampleRate: 1, userId: 'user-7' }, TELEMETRY, { appName: 'web', environment: 'production' }, { env: f.env, load: rec.load });
  assert.ok(h);
  assert.equal(rum.getReplayId(), h.sessionId);
  assert.equal(rec.state.configs[0].maskAllInputs, true);
  rec.state.emit({ type: 4, timestamp: 1, data: { href: 'https://u:p@app.example.test/orders/42?token=secret', width: 1, height: 1 } });
  rec.state.emit({ type: 2, timestamp: 2, data: { node: { type: 0, childNodes: [] } } });
  rum.reportRumError(new Error('boom for jane@example.com'));
  await flushMicro();
  rec.state.emit({ type: 3, timestamp: 3, data: { source: 2 } });
  h._flush();
  await flushMicro();
  await flushMicro();
  const up = uploads(f.calls);
  assert.ok(up.length >= 2);
  const first = decode(up[0]);
  const second = decode(up[1]);
  assert.equal(first.v, 1);
  assert.equal(first.sessionId, h.sessionId);
  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.equal(first.userId, 'user-7');
  assert.equal(first.app, 'web');
  assert.match(first.subjectId, /^user-7$/);
  assert.equal(first.page, '/orders/42');
  const meta = first.events.find((e) => e.type === 4);
  assert.doesNotMatch(meta.data.href, /secret|u:p@/);
  const err = first.events.find((e) => e.type === 5 && e.data.tag === 'error');
  assert.equal(err.data.payload.message, 'boom for [EMAIL]');
  assert.equal(first.errors, 1);
  assert.equal(up[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(up[0].init.credentials, 'omit');
  assert.equal(JSON.parse(f.env.session.getItem('platform.replay.session')).seq, 2);
});

test('on-error buffer: nothing uploaded until an error, then the buffer is sent', async () => {
  const f = fakeEnv({ serverAllows: true, random: () => 0.5 }); // 0.5 >= 0.1 sample, < 1 on-error
  const rec = fakeRecorder();
  const h = await replay.startReplay({}, TELEMETRY, {}, { env: f.env, load: rec.load });
  assert.equal(h.mode, 'buffer');
  assert.equal(rec.state.configs[0].checkoutEveryNms, 60_000);
  rec.state.emit({ type: 4, timestamp: 1, data: { href: 'https://app.example.test/' } }, true);
  rec.state.emit({ type: 2, timestamp: 2, data: {} }, true);
  for (let i = 0; i < 50; i++) rec.state.emit({ type: 3, timestamp: 10 + i, data: { source: 1 } });
  h._flush();
  await flushMicro();
  assert.equal(uploads(f.calls).length, 0, 'buffer mode must not upload before an error');
  for (const fn of f.listeners.error) fn({ message: 'Uncaught TypeError', error: { name: 'TypeError', message: 'x is undefined' } });
  await flushMicro();
  await flushMicro();
  const up = uploads(f.calls);
  assert.equal(up.length, 1);
  const body = decode(up[0]);
  assert.equal(body.mode, 'session');
  assert.ok(body.events.length >= 52);
  assert.equal(body.events[0].type, 4);
  assert.equal(h.mode, 'session');
});

test('SPA navigation adds a marker and a fresh snapshot; network spans become markers', async () => {
  const f = fakeEnv({ serverAllows: true });
  const rec = fakeRecorder();
  const h = await replay.startReplay({ sampleRate: 1 }, TELEMETRY, {}, { env: f.env, load: rec.load });
  f.env.win.location.href = 'https://app.example.test/orders/101';
  h._checkNav();
  assert.deepEqual(rec.state.custom.at(-1), { tag: 'navigation', payload: { path: '/orders/101', route: '/orders/:id' } });
  rum.emitRumSpan({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), method: 'GET', url: 'https://api.example.test/users?email=x@y.z', startMs: 0, endMs: 12, status: 503, error: false });
  const net = rec.state.custom.find((c) => c.tag === 'network');
  assert.equal(net.payload.traceId, 'a'.repeat(32));
  assert.equal(net.payload.failed, true);
  assert.doesNotMatch(net.payload.url, /x@y/);
  // the replay API itself is never recorded as a network marker
  rum.emitRumSpan({ traceId: 'c'.repeat(32), spanId: 'd', method: 'POST', url: TELEMETRY.replayEndpoint + '/chunks', startMs: 0, endMs: 1, status: 202, error: false });
  assert.equal(rec.state.custom.filter((c) => c.tag === 'network').length, 1);
  h._flush();
  await flushMicro();
  const body = decode(uploads(f.calls)[0]);
  assert.deepEqual(body.traceIds, ['a'.repeat(32)]);
  assert.equal(body.networkErrors, 1);
  assert.ok(body.pages.includes('/orders/101'));
});

// ------------------------------------------------------------------ chunker + uploader

test('chunker flushes on size, on interval and keeps oversized events alone', () => {
  const out = [];
  const timers = [];
  const c = new replay.ReplayChunker((ch) => out.push(ch), { maxBytes: 4096, flushIntervalMs: 5000, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {} });
  const ev = (n) => JSON.stringify({ type: 3, timestamp: n, data: 'x'.repeat(1000) });
  for (let i = 0; i < 5; i++) c.add(ev(i), i);
  assert.equal(out.length, 1, 'flushed when 4 KiB was exceeded');
  assert.ok(out[0].bytes <= 4096);
  assert.equal(timers[0].ms, 5000);
  timers.at(-1).fn(); // interval flush
  assert.equal(out.length, 2);
  c.add(JSON.stringify({ big: 'y'.repeat(10000) }), 9);
  assert.equal(out.length, 3);
  assert.equal(out[2].events.length, 1);
  c.flush();
  assert.equal(out.length, 3, 'empty flush is a no-op');
  const env = JSON.parse(replay.buildEnvelope({ sessionId: 's', seq: 0, mode: 'session', page: '/', subjectId: 'anon-x' }, out[0]));
  assert.equal(env.events.length, out[0].events.length);
});

test('uploader retries with backoff, honours Retry-After, drops bad chunks and stops on 403', async () => {
  const statuses = [500, 429, 202, 400, 403];
  const sent = [];
  const timers = [];
  let now = 0;
  const fatal = [];
  const up = new replay.ReplayUploader({
    url: 'https://api/chunks',
    token: 't',
    compress: (s) => Buffer.from(s),
    now: () => now,
    random: () => 0,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    fetchImpl: async (url, init) => {
      sent.push(init);
      const status = statuses.shift();
      return { status, headers: { get: (h) => (status === 429 && h === 'Retry-After' ? '7' : null) } };
    },
    onFatal: (s) => fatal.push(s),
  });
  up.enqueue(0, 'a');
  await flushMicro();
  assert.equal(timers.at(-1).ms, 500); // 1 s exponential, lower half with random()=0
  now += 500; timers.at(-1).fn(); await flushMicro();
  assert.equal(timers.at(-1).ms, 7000); // Retry-After
  now += 7000; timers.at(-1).fn(); await flushMicro();
  assert.equal(up.sent, 1);
  assert.equal(up.pending, 0);
  up.enqueue(1, 'bad');
  await flushMicro();
  assert.equal(up.dropped, 1);
  up.enqueue(2, 'c');
  await flushMicro();
  assert.deepEqual(fatal, [403]);
  assert.equal(up.stopped, true);
  up.enqueue(3, 'd');
  assert.equal(sent.length, 5);
  assert.ok(sent.every((i) => i.credentials === 'omit' && i.headers.Authorization === 'Bearer t'));
});

test('uploader queue is bounded and unload flush uses keepalive within 64 KiB', async () => {
  const sent = [];
  const up = new replay.ReplayUploader({
    url: 'u', token: 't', compress: (s) => Buffer.from(s), maxQueueBytes: 50_000,
    fetchImpl: (url, init) => { sent.push(init); return new Promise(() => {}); }, // never resolves
    setTimer: () => {},
  });
  up.enqueue(0, 'h'.repeat(10)); // in flight
  for (let i = 1; i <= 6; i++) up.enqueue(i, 'x'.repeat(20_000));
  assert.ok(up.dropped >= 3, 'oldest dropped when the queue is full');
  up.flushUnload();
  const keep = sent.filter((i) => i.keepalive);
  assert.ok(keep.length >= 1);
  assert.ok(keep.reduce((a, i) => a + i.body.length, 0) <= 60_000);
});

test('a refused keepalive request puts the chunk back for the normal retry path', async () => {
  let calls = 0;
  const timers = [];
  const up = new replay.ReplayUploader({
    url: 'u', token: 't', compress: (s) => Buffer.from(s), random: () => 0,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    fetchImpl: async (url, init) => {
      calls++;
      if (init.keepalive) throw new TypeError('Preflight request for request with keepalive specified is currently not supported');
      return { status: 202, headers: { get: () => null } };
    },
  });
  up.queue.push({ seq: 0, body: Buffer.from('a') }); // queued while hidden, nothing in flight
  up.queuedBytes = 1;
  up.flushUnload();
  await flushMicro();
  assert.equal(up.pending, 1, 'requeued');
  timers.at(-1).fn();
  await flushMicro();
  assert.equal(up.pending, 0);
  assert.equal(up.sent, 1);
  assert.equal(calls, 2);
});

test('errors carry the replay id; exports are lazy wrappers', async () => {
  rum.setReplayIdForErrors('sess-1');
  assert.equal(rum.getReplayId(), 'sess-1');
  rum.setReplayIdForErrors(undefined);
  assert.equal(typeof rum.setConsent, 'function');
  assert.equal(typeof rum.stopReplay, 'function');
});
