// Heatmap capture unit tests (run via `npm test`, which builds first). Shared logic: keep
// identical in sdk-react and sdk-angular (tests/rum-heatmap.test.cjs).
try { require('@angular/compiler'); } catch { /* React SDK: not installed */ } // Angular SDK: JIT for rum-deps -> @angular/common
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/rum'); // framework-free entry (same file in both SDKs)
const hm = require('../dist/rum-heatmap');

const CONFIG = { endpoint: 'https://platform.example.test/api/sdk/heatmap/events', token: 'sdk_live_browser', flushIntervalMs: 5000, maxBatch: 3 };

function element(tag, { id = '', className = '', rumName = null, parent = null, text = 'Card 4242 4242 jane@example.com' } = {}) {
  const el = {
    nodeType: 1, tagName: tag.toUpperCase(), id, className, parentElement: parent, textContent: text, innerText: text,
    getAttribute: (n) => (n === 'data-rum-name' ? rumName : null),
  };
  el.closest = () => el;
  return el;
}

function fakeBrowser({ path = '/orders/42', width = 1280, height = 800, docW = 1280, docH = 4000, nav = {}, replies = [] } = {}) {
  const listeners = {};
  const on = (target) => ({
    addEventListener: (type, fn) => { listeners[`${target}:${type}`] = fn; },
    removeEventListener: (type) => { delete listeners[`${target}:${type}`]; },
  });
  const sent = [];
  const timers = [];
  let clock = 1_000_000;
  const doc = { documentElement: { scrollWidth: docW, scrollHeight: docH, clientWidth: width, clientHeight: height }, body: {}, visibilityState: 'visible', ...on('doc') };
  const win = { document: doc, innerWidth: width, innerHeight: height, scrollY: 0, location: { pathname: path }, ...on('win') };
  const env = {
    win, doc, nav, storage: null, random: () => 0.5,
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
    fetchImpl: async (url, init) => {
      sent.push({ url, init, body: JSON.parse(init.body) });
      const r = replies.length ? replies.shift() : { status: 202, body: { accepted: 1 } };
      return { status: r.status, headers: { get: (n) => (n === 'Retry-After' ? r.retryAfter ?? null : null) }, json: async () => r.body || {} };
    },
  };
  win.fetch = env.fetchImpl;
  return {
    env, win, doc, sent, timers, listeners,
    advance: (ms) => { clock += ms; },
    click: (target, pageX, pageY) => listeners['doc:click']({ target, pageX, pageY }),
    scrollTo: (y) => { win.scrollY = y; clock += 1000; listeners['win:scroll'](); },
  };
}

test('pure helpers: viewport buckets, normalised clicks, scroll depth', () => {
  assert.equal(hm.viewportBucket(390), 'mobile');
  assert.equal(hm.viewportBucket(800), 'tablet');
  assert.equal(hm.viewportBucket(1280), 'desktop');
  assert.deepEqual(hm.normalizeClick(640, 1000, 1280, 4000), { x: 0.5, y: 0.25 });
  assert.deepEqual(hm.normalizeClick(2000, -5, 1280, 4000), { x: 1, y: 0 });
  assert.equal(hm.normalizeClick(1, 1, 0, 100), null);
  assert.equal(hm.scrollDepth(0, 800, 4000), 20);
  assert.equal(hm.scrollDepth(3200, 800, 4000), 100);
  assert.equal(hm.scrollDepth(0, 800, 600), 100);
  assert.equal(hm.scrollDepth(1000, 800, 0), 100);
});

test('selector has structure only, never text or values', () => {
  const card = element('div', { className: 'card promo' });
  const btn = element('button', { className: 'btn btn-primary x', parent: card });
  const sel = hm.heatmapSelector(btn);
  assert.equal(sel, 'div.card.promo > button.btn.btn-primary');
  assert.doesNotMatch(sel, /4242|jane/);
  assert.equal(hm.heatmapSelector(element('a', { id: 'buy' })), 'a#buy');
  assert.equal(hm.heatmapSelector(element('button', { rumName: 'checkout' })), 'button[data-rum-name="checkout"]');
  assert.equal(hm.heatmapSelector(null), undefined);
});

test('backoff honours Retry-After, else grows exponentially with jitter (capped)', () => {
  assert.equal(hm.backoffMs(1, '30', () => 0), 30_000);
  assert.equal(hm.backoffMs(1, null, () => 0), 500);
  assert.equal(hm.backoffMs(3, null, () => 1), 4000);
  assert.equal(hm.backoffMs(20, null, () => 1), 60_000);
});

test('Do-Not-Track / GPC, sampling and missing config install nothing', () => {
  for (const nav of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
    const b = fakeBrowser({ nav });
    assert.equal(hm.createHeatmapCollector(CONFIG, b.env), null);
    assert.equal(Object.keys(b.listeners).length, 0);
  }
  const b = fakeBrowser();
  assert.equal(hm.createHeatmapCollector({ ...CONFIG, samplingRatio: 0 }, b.env), null);
  assert.equal(hm.createHeatmapCollector({ ...CONFIG, samplingRatio: 0.4 }, { ...b.env, random: () => 0.9 }), null);
  assert.equal(Object.keys(b.listeners).length, 0);
  assert.equal(hm.resolveHeatmapConfig(undefined, {}), null);
  assert.equal(hm.resolveHeatmapConfig(true, { browserToken: 't' }), null, 'no endpoint');
  assert.deepEqual(hm.resolveHeatmapConfig(true, { heatmapsEndpoint: 'https://x/api/sdk/heatmap/events', browserToken: 'web' }),
    { endpoint: 'https://x/api/sdk/heatmap/events', token: 'web' });
  assert.equal(hm.resolveHeatmapConfig({ token: 'sdk_live_b' }, { heatmapsEndpoint: 'https://x/e', heatmapsToken: 'h' }).token, 'sdk_live_b');
});

test('clicks are batched with normalised coordinates, viewport bucket and normalised page', async () => {
  const b = fakeBrowser();
  const c = hm.createHeatmapCollector(CONFIG, b.env);
  b.click(element('button', { id: 'buy' }), 640, 1000);
  b.click(element('a', { id: 'more' }), 128, 400);
  assert.equal(b.sent.length, 0, 'below maxBatch: waits for the timer');
  assert.equal(c.pending().length, 2);
  b.click(element('a', { id: 'x' }), 0, 0); // third event reaches maxBatch=3 -> flush
  await new Promise((r) => setImmediate(r));
  assert.equal(b.sent.length, 1);
  const req = b.sent[0];
  assert.equal(req.url, CONFIG.endpoint);
  assert.equal(req.init.headers.Authorization, 'Bearer sdk_live_browser');
  assert.equal(req.init.credentials, 'omit');
  assert.deepEqual(req.body.events[0], { type: 'click', page: '/orders/:id', viewport: 'desktop', x: 0.5, y: 0.25, selector: 'button#buy' });
  assert.equal(req.body.events.length, 3);
  assert.equal(req.body.subjectId, undefined);
  assert.doesNotMatch(JSON.stringify(req.body), /4242|jane|session/i);
  assert.equal(c.pending().length, 0);
  c.stop();
  assert.equal(Object.keys(b.listeners).length, 0, 'stop removes every listener');
});

test('max scroll depth is sent once per page view: on route change and when the tab is hidden', async () => {
  const b = fakeBrowser({ docH: 4000, height: 800 });
  const c = hm.createHeatmapCollector({ ...CONFIG, maxBatch: 100 }, b.env);
  b.scrollTo(1200); // 50%
  b.scrollTo(400); // going back up keeps the max
  b.win.location.pathname = '/pricing';
  b.scrollTo(0); // route change detected on the next event
  assert.deepEqual(c.pending(), [{ type: 'scroll', page: '/orders/:id', viewport: 'desktop', depth: 50 }]);
  b.scrollTo(3200);
  b.doc.visibilityState = 'hidden';
  b.listeners['doc:visibilitychange']();
  b.listeners['win:pagehide']();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].init.keepalive, true, 'unload flush uses keepalive');
  assert.deepEqual(b.sent[0].body.events.map((e) => [e.page, e.depth]), [['/orders/:id', 50], ['/pricing', 100]]);
  c.stop();
});

test('failures back off and keep events; 4xx drops; 401 and consent:false stop capture', async () => {
  const b = fakeBrowser({ replies: [{ status: 503, retryAfter: '10' }, { status: 202, body: { accepted: 1 } }] });
  const c = hm.createHeatmapCollector({ ...CONFIG, maxBatch: 100 }, b.env);
  b.click(element('a', { id: 'a' }), 1, 1);
  await c.flush();
  assert.equal(b.sent.length, 1);
  assert.equal(c.pending().length, 1, 'kept for retry');
  await c.flush();
  assert.equal(b.sent.length, 1, 'blocked during Retry-After');
  b.advance(10_001);
  await c.flush();
  assert.equal(b.sent.length, 2);
  assert.equal(c.pending().length, 0);
  c.stop();

  const bad = fakeBrowser({ replies: [{ status: 400 }, { status: 401 }] });
  const c2 = hm.createHeatmapCollector({ ...CONFIG, maxBatch: 100 }, bad.env);
  bad.click(element('a', { id: 'a' }), 1, 1);
  await c2.flush();
  assert.equal(c2.pending().length, 0, '400 is dropped, not retried');
  bad.click(element('a', { id: 'a' }), 1, 1);
  await c2.flush();
  assert.equal(c2.stopped, true, '401 stops the collector');

  const denied = fakeBrowser({ replies: [{ status: 202, body: { accepted: 0, consent: false } }] });
  const c3 = hm.createHeatmapCollector({ ...CONFIG, maxBatch: 100, subjectId: () => 'user-7' }, denied.env);
  denied.click(element('a', { id: 'a' }), 1, 1);
  await c3.flush();
  assert.equal(denied.sent[0].body.subjectId, 'user-7');
  assert.equal(c3.stopped, true, 'server-side #47 consent denial stops capture');
});

test('consent callback gates every send', async () => {
  let allowed = false;
  const b = fakeBrowser();
  const c = hm.createHeatmapCollector({ ...CONFIG, maxBatch: 100, consent: () => allowed }, b.env);
  b.click(element('a', { id: 'a' }), 1, 1);
  await c.flush();
  assert.equal(b.sent.length, 0);
  assert.equal(c.pending().length, 0, 'events captured without consent are discarded');
  allowed = true;
  b.click(element('a', { id: 'a' }), 1, 1);
  await c.flush();
  assert.equal(b.sent.length, 1);
  c.stop();
});

test('startHeatmaps: consent denied up front installs nothing; otherwise chains stop into the RUM handle', async () => {
  const b = fakeBrowser();
  const plan = { browserToken: 'plat_ingest_web_x', options: { heatmaps: { consent: async () => false } } };
  const telemetry = { heatmapsEndpoint: CONFIG.endpoint };
  assert.equal(await hm.startHeatmaps(plan, telemetry, { win: b.win, nav: {} }, null), null);
  assert.equal(Object.keys(b.listeners).length, 0);
  let rumStopped = false;
  const handle = { stop: () => { rumStopped = true; } };
  const c = await hm.startHeatmaps({ ...plan, options: { heatmaps: true } }, telemetry, { win: b.win, nav: {}, storage: null }, handle);
  assert.ok(c);
  handle.stop();
  assert.equal(c.stopped, true);
  assert.equal(rumStopped, true);
  assert.equal(await hm.startHeatmaps({ ...plan, options: {} }, telemetry, { win: b.win }, null), null, 'off unless rum.heatmaps is set');
});

test('initRum starts heatmaps only when rum.heatmaps is set', async () => {
  const b = fakeBrowser();
  const handle = { setView() {}, getSessionId() {}, getViewId: () => 'v', pushEvent() {}, pushError() {}, stop() {} };
  const load = async () => ({ startFaro: () => handle });
  const telemetry = { enabled: true, faroEndpoint: 'https://otel.example.test/collect', browserToken: 'plat_ingest_web_x', heatmapsEndpoint: CONFIG.endpoint };
  const env = { win: b.win, nav: {}, storage: null };
  await sdk.initRum({ telemetry }, {}, { load, env });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.listeners['doc:click'], undefined);
  sdk.stopRum();
  await sdk.initRum({ telemetry, heatmaps: true }, {}, { load, env });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(typeof b.listeners['doc:click'], 'function');
  sdk.stopRum();
  assert.equal(b.listeners['doc:click'], undefined, 'stopRum stops heatmaps too');
});

test('inlined helpers stay identical to rum.ts (page keys, DNT)', () => {
  for (const p of ['/', '/users/42', '/u/550e8400-e29b-41d4-a716-446655440000/edit', '/x/jane%40example.com', '/t/abcdefabcdefabcdef?q=1', '/plain/path#h']) {
    assert.equal(hm.normalizeRouteName(p), sdk.normalizeRouteName(p), p);
  }
  for (const nav of [{}, { doNotTrack: '1' }, { msDoNotTrack: '1' }, { globalPrivacyControl: true }, { doNotTrack: 'unspecified' }]) {
    assert.equal(hm.isDoNotTrack(nav, {}), sdk.isDoNotTrack(nav, {}));
  }
});
