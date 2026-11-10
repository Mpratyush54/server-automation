const test = require('node:test');
const assert = require('node:assert/strict');
const { PlatformTransport } = require('../dist/rum-transport');
test('scrubbed Faro exceptions mirror to project ingest with release, frames and breadcrumbs', async () => {
  const calls = [];
  const t = new PlatformTransport({ url: 'https://otel.example.test/collect', errorsUrl: 'https://platform.example.test/api/errors/rum', token: 'web-test', release: '1.2.3', replayId: () => 'replay-test', fetchImpl: async (url, init) => {
    calls.push({ url, init }); return { status: 202 };
  }});
  t.send([{ type: 'event', payload: { name: 'cart opened' }, meta: {} }, {
    type: 'exception', payload: { type: 'TypeError', value: 'cart failed', stacktrace: { frames: [{ filename: '/app.js', lineno: 2, colno: 4, function: 'checkout' }] } },
    meta: { app: { environment: 'prod' }, session: { id: 'session-test' } }
  }]);
  await new Promise(r => setImmediate(r));
  const errorCall = calls.find(c => c.url.endsWith('/errors/rum'));
  const e = JSON.parse(errorCall.init.body);
  assert.equal(e.release, '1.2.3'); assert.equal(e.sessionId, 'session-test'); assert.equal(e.replayId, 'replay-test');
  assert.equal(e.frames[0].column, 3); assert.equal(e.breadcrumbs[0].message, 'cart opened');
  assert.equal(errorCall.init.credentials, 'omit');
  assert.equal(errorCall.init.headers.Authorization, 'Bearer web-test');
  assert.ok(t.getIgnoreUrls().includes(errorCall.url));
  assert.ok(calls.some(c => c.url.endsWith('/collect')));
});
