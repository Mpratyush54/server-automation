// RUM transport + web-vitals tests (identical in sdk-react and sdk-angular).
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlatformTransport, retryAfterMs } = require('../dist/rum-transport');
const { vitalMeasurement } = require('../dist/rum-vitals');

const flush = () => new Promise((r) => setImmediate(r));

function harness(responses) {
  const calls = [];
  const timers = [];
  let clock = 1_000_000;
  const t = new PlatformTransport({
    url: 'https://otel.example.test/collect',
    token: 'plat_ingest_web_abc',
    maxQueue: 3,
    now: () => clock,
    random: () => 0.5,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift() || { status: 202 };
      if (r.throw) throw new Error('network');
      return { status: r.status, headers: { get: (k) => (r.headers || {})[k.toLowerCase()] ?? null } };
    },
  });
  return {
    t,
    calls,
    timers,
    advance(ms) {
      clock += ms;
      const due = timers.splice(0);
      due.forEach((x) => x.fn());
    },
  };
}

const item = (n) => ({ type: 'event', payload: { name: `e${n}` }, meta: { session: { id: 's' } } });

test('sends one batch per call to the Faro endpoint with the browser token, never credentials', async () => {
  const h = harness([]);
  h.t.send([item(1), item(2)]);
  await flush();
  assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://otel.example.test/collect');
  assert.equal(init.headers.Authorization, 'Bearer plat_ingest_web_abc');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.keepalive, true);
  assert.deepEqual(JSON.parse(init.body).events.map((e) => e.name), ['e1', 'e2']);
  assert.ok(h.t.isBatched());
  assert.deepEqual(h.t.getIgnoreUrls(), ['https://otel.example.test/collect']);
});

test('429 honours Retry-After before retrying the same batch', async () => {
  const h = harness([{ status: 429, headers: { 'retry-after': '7' } }]);
  h.t.send([item(1)]);
  await flush();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers[0].ms, 7000);
  h.t.send([item(2)]); // queued while blocked, not sent
  await flush();
  assert.equal(h.calls.length, 1);
  h.advance(7000);
  await flush();
  await flush();
  await flush();
  assert.equal(h.calls.length, 3, 'retried batch 1, then batch 2');
  assert.equal(JSON.parse(h.calls[1].init.body).events[0].name, 'e1');
  assert.equal(JSON.parse(h.calls[2].init.body).events[0].name, 'e2');
});

test('network errors back off exponentially with jitter; the queue is bounded and drops are counted', async () => {
  const h = harness([{ throw: true }, { status: 502 }]);
  h.t.send([item(1)]);
  await flush();
  await flush();
  assert.equal(h.timers[0].ms, 750, '1 s window, jittered into [0.5 s, 1 s]');
  h.advance(750);
  await flush();
  await flush();
  assert.equal(h.timers[0].ms, 1500, 'second failure doubles the window');
  for (let i = 2; i <= 5; i++) h.t.send([item(i)]);
  assert.equal(h.t.dropped, 2, 'maxQueue=3: the two oldest batches were dropped');
});

test('permanent 4xx responses are dropped, not retried', async () => {
  const h = harness([{ status: 401 }]);
  h.t.send([item(1)]);
  await flush();
  await flush();
  assert.equal(h.t.dropped, 1);
  assert.equal(h.timers.length, 0);
});

test('retryAfterMs parses seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('3', 0), 3000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs('soon', 0), null);
  assert.equal(retryAfterMs(null, 0), null);
});

test('web-vitals metrics become Faro measurements tagged with the view id', () => {
  for (const name of ['LCP', 'INP', 'CLS', 'TTFB', 'FCP']) {
    const { measurement, options } = vitalMeasurement({ name, value: 12.5, delta: 2, id: 'v5-1', rating: 'good', navigationType: 'navigate' }, 'view-9');
    assert.equal(measurement.type, 'web-vitals');
    assert.deepEqual(measurement.values, { [name.toLowerCase()]: 12.5, delta: 2 });
    assert.deepEqual(options.context, { id: 'v5-1', rating: 'good', navigation_type: 'navigate', view_id: 'view-9' });
  }
});
