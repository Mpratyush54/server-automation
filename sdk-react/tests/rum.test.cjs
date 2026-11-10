// RUM unit tests (run via `npm test`, which builds first). Shared logic: keep in sync with
// sdk-angular/tests/rum.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist');
const { installPropagation } = require('../dist/rum-propagation');
const faroMod = require('../dist/rum-faro');

const TELEMETRY = {
  enabled: true,
  faroEndpoint: 'https://otel.example.test/collect',
  browserToken: 'plat_ingest_web_abc',
  samplingRatio: 1,
  resource: { 'platform.project_id': 'proj-1', 'deployment.environment': 'production' },
};

function fakeEnv(overrides = {}) {
  const store = new Map();
  return {
    win: { document: {}, location: { origin: 'https://app.example.test', pathname: '/users/42' }, ...(overrides.win || {}) },
    nav: overrides.nav || {},
    storage: overrides.storage === undefined
      ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) }
      : overrides.storage,
    random: overrides.random,
  };
}

function fakeLoader() {
  const calls = [];
  const views = [];
  const handle = {
    setView: (name) => views.push(name),
    getSessionId: () => 'sess-1',
    getViewId: () => 'view-1',
    pushEvent: () => {},
    stop: () => {},
  };
  return {
    calls,
    views,
    load: async () => ({
      startFaro: (plan, initialView) => {
        calls.push({ plan, initialView });
        return handle;
      },
    }),
  };
}

test.afterEach(() => sdk.stopRum());

// ------------------------------------------------------------------ init on/off

test('initRum without options or telemetry loads nothing', async () => {
  for (const options of [undefined, null, false]) {
    const loader = fakeLoader();
    assert.equal(await sdk.initRum(options, {}, { load: loader.load, env: fakeEnv() }), null);
    assert.equal(loader.calls.length, 0);
  }
  for (const telemetry of [null, { enabled: false, faroEndpoint: null }, { ...TELEMETRY, faroEndpoint: null }, { ...TELEMETRY, browserToken: '' }]) {
    sdk.stopRum();
    const loader = fakeLoader();
    assert.equal(await sdk.initRum({ telemetry }, {}, { load: loader.load, env: fakeEnv() }), null);
    assert.equal(loader.calls.length, 0, `Faro must not load for ${JSON.stringify(telemetry)}`);
  }
});

test('initRum without a browser (SSR) loads nothing', async () => {
  const loader = fakeLoader();
  const env = fakeEnv();
  env.win = undefined;
  assert.equal(await sdk.initRum({ telemetry: TELEMETRY }, {}, { load: loader.load, env }), null);
  assert.equal(loader.calls.length, 0);
});

test('initRum with enabled telemetry loads Faro once with the collector, token and defaults', async () => {
  const loader = fakeLoader();
  const opts = { telemetry: TELEMETRY };
  const a = sdk.initRum(opts, { appName: 'shop', environment: 'staging' }, { load: loader.load, env: fakeEnv() });
  const b = sdk.initRum(opts, {}, { load: loader.load, env: fakeEnv() });
  assert.equal(await a, await b);
  assert.ok(await a);
  assert.equal(loader.calls.length, 1);
  const { plan, initialView } = loader.calls[0];
  assert.equal(plan.faroEndpoint, TELEMETRY.faroEndpoint);
  assert.equal(plan.browserToken, TELEMETRY.browserToken);
  assert.equal(plan.appName, 'shop');
  assert.equal(plan.environment, 'staging');
  assert.deepEqual(plan.propagateTo, ['https://app.example.test'], 'default propagation is same-origin only');
  assert.equal(initialView, '/users/:id');
});

test('initRum fetches telemetryUrl without credentials when no telemetry block is given', async () => {
  const loader = fakeLoader();
  const fetched = [];
  const env = fakeEnv({
    win: {
      fetch: async (url, init) => {
        fetched.push({ url, init });
        return { ok: true, json: async () => ({ telemetry: TELEMETRY }) };
      },
    },
  });
  assert.ok(await sdk.initRum({ telemetryUrl: '/rum-config' }, {}, { load: loader.load, env }));
  assert.deepEqual(fetched, [{ url: '/rum-config', init: { credentials: 'omit' } }]);
  assert.equal(loader.calls.length, 1);
});

test('a failing Faro load never throws into the app', async () => {
  const res = await sdk.initRum({ telemetry: TELEMETRY }, {}, { load: async () => { throw new Error('chunk 404'); }, env: fakeEnv() });
  assert.equal(res, null);
});

// ------------------------------------------------------------------ doNotTrack

test('doNotTrack / Global Privacy Control disable RUM unless explicitly overridden', async () => {
  for (const nav of [{ doNotTrack: '1' }, { msDoNotTrack: '1' }, { globalPrivacyControl: true }]) {
    sdk.stopRum();
    const loader = fakeLoader();
    assert.equal(await sdk.initRum({ telemetry: TELEMETRY }, {}, { load: loader.load, env: fakeEnv({ nav }) }), null);
    assert.equal(loader.calls.length, 0);
  }
  sdk.stopRum();
  const loader = fakeLoader();
  assert.ok(await sdk.initRum({ telemetry: TELEMETRY, respectDoNotTrack: false }, {}, { load: loader.load, env: fakeEnv({ nav: { doNotTrack: '1' } }) }));
  assert.equal(loader.calls.length, 1);
  assert.equal(sdk.isDoNotTrack({ doNotTrack: '0' }, { doNotTrack: null }), false);
  assert.equal(sdk.isDoNotTrack({}, { doNotTrack: '1' }), true);
});

// ------------------------------------------------------------------ sampling

test('sampling: 0 never loads, ratio is session-sticky, option overrides platform ratio', async () => {
  let loader = fakeLoader();
  assert.equal(await sdk.initRum({ telemetry: { ...TELEMETRY, samplingRatio: 0 } }, {}, { load: loader.load, env: fakeEnv() }), null);
  assert.equal(loader.calls.length, 0);

  sdk.stopRum();
  loader = fakeLoader();
  assert.equal(await sdk.initRum({ telemetry: TELEMETRY, samplingRatio: 0.5 }, {}, { load: loader.load, env: fakeEnv({ random: () => 0.7 }) }), null);
  assert.equal(loader.calls.length, 0);

  sdk.stopRum();
  loader = fakeLoader();
  assert.ok(await sdk.initRum({ telemetry: { ...TELEMETRY, samplingRatio: 0.5 } }, {}, { load: loader.load, env: fakeEnv({ random: () => 0.3 }) }));
  assert.equal(loader.calls[0].plan.samplingRatio, 0.5);

  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(sdk.decideSampled(0.5, storage, () => 0.1), true);
  assert.equal(sdk.decideSampled(0.5, storage, () => 0.9), true, 'decision sticks for the session');
  assert.equal(sdk.decideSampled(1, null, () => 0.99), true);
  assert.equal(sdk.decideSampled(0.2, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, () => 0.1), true);
});

// ------------------------------------------------------------------ propagation allow-list

test('shouldPropagate only allows configured origins / prefixes / regexps', () => {
  const page = 'https://app.example.test';
  assert.equal(sdk.shouldPropagate('/api/x', undefined, page), true, 'same-origin by default');
  assert.equal(sdk.shouldPropagate('https://api.other.test/x', undefined, page), false);
  const list = ['https://api.example.test', 'https://gw.example.test/v1/', /^https:\/\/[a-z]+\.internal\.test\//];
  assert.equal(sdk.shouldPropagate('https://api.example.test/orders?id=1', list, page), true);
  assert.equal(sdk.shouldPropagate('https://api.example.test.evil.test/orders', list, page), false);
  assert.equal(sdk.shouldPropagate('http://api.example.test/orders', list, page), false, 'scheme is part of the origin');
  assert.equal(sdk.shouldPropagate('https://gw.example.test/v1/users', list, page), true);
  assert.equal(sdk.shouldPropagate('https://gw.example.test/v1', list, page), true);
  assert.equal(sdk.shouldPropagate('https://gw.example.test/v10/users', list, page), false);
  assert.equal(sdk.shouldPropagate('https://gw.example.test/admin', list, page), false);
  assert.equal(sdk.shouldPropagate('https://svc.internal.test/a', list, page), true);
  assert.equal(sdk.shouldPropagate('/api/x', list, page), false, 'explicit list replaces the same-origin default');
  assert.equal(sdk.shouldPropagate('/api/x', [], page), false, '[] disables propagation');
  assert.equal(sdk.shouldPropagate('data:text/plain,hi', [/.*/], page), false);
});

function fakeWindow() {
  const sent = [];
  class FakeXHR {
    constructor() { this.headers = {}; this.listeners = {}; this.status = 0; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v; }
    addEventListener(t, fn) { this.listeners[t] = fn; }
    removeEventListener(t) { delete this.listeners[t]; }
    send() { sent.push(this); this.status = 201; this.listeners.loadend && this.listeners.loadend(); }
  }
  const fetched = [];
  return {
    sent,
    fetched,
    win: {
      Headers,
      XMLHttpRequest: FakeXHR,
      fetch: async (input, init) => {
        fetched.push({ input, init });
        return { status: 200 };
      },
    },
  };
}

test('traceparent is added only to allowed fetch/XHR targets and a client span is reported', async () => {
  const w = fakeWindow();
  const origFetch = w.win.fetch;
  const spans = [];
  const allow = (url) => sdk.shouldPropagate(url, ['https://api.example.test'], 'https://app.example.test');
  const uninstall = installPropagation({ allow, onSpan: (s) => spans.push(s), win: w.win, now: () => 1000 });

  await w.win.fetch('https://api.example.test/orders', { method: 'post', headers: { 'X-A': '1' } });
  await w.win.fetch('https://third-party.test/pixel');
  const tp = new Headers(w.fetched[0].init.headers).get('traceparent');
  assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(new Headers(w.fetched[0].init.headers).get('x-a'), '1', 'existing headers kept');
  assert.equal(w.fetched[1].init, undefined, 'third-party request untouched');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].method, 'POST');
  assert.equal(spans[0].status, 200);
  assert.equal(tp, `00-${spans[0].traceId}-${spans[0].spanId}-01`);

  // An app-provided traceparent wins; no duplicate span.
  await w.win.fetch('https://api.example.test/x', { headers: { traceparent: '00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01' } });
  assert.equal(spans.length, 1);

  const ok = new w.win.XMLHttpRequest();
  ok.open('GET', 'https://api.example.test/users');
  ok.send();
  const blocked = new w.win.XMLHttpRequest();
  blocked.open('GET', 'https://cdn.other.test/lib.js');
  blocked.send();
  assert.match(ok.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(blocked.headers.traceparent, undefined);
  assert.equal(spans.length, 2);
  assert.equal(spans[1].status, 201);

  uninstall();
  assert.equal(w.win.fetch, origFetch, 'uninstall restores fetch');
});

// ------------------------------------------------------------------ redaction

test('scrubTransportItem redacts tokens, JWTs, e-mails, URL query values and user identifiers', () => {
  const item = {
    type: 'exception',
    payload: {
      type: 'Error',
      value: 'failed for jane.doe@example.com with Authorization: Bearer eyJa.eyJb.sig token=sdk_live_secret',
      stacktrace: { frames: [{ filename: 'https://app.example.test/main.js?sig=abc123', function: 'f' }] },
    },
    meta: {
      page: { url: 'https://user:pw@app.example.test/reset?email=jane@example.com&token=xyz#access_token=abc' },
      user: { id: 'u1', email: 'jane@example.com', username: 'jane', fullName: 'Jane Doe' },
    },
  };
  const out = sdk.scrubTransportItem(item);
  const json = JSON.stringify(out);
  for (const secret of ['jane.doe@example.com', 'jane@example.com', 'eyJa.eyJb.sig', 'sdk_live_secret', 'abc123', 'xyz', 'user:pw', 'access_token=abc', 'Jane Doe', '"jane"']) {
    assert.ok(!json.includes(secret), `${secret} leaked: ${json}`);
  }
  assert.equal(out.meta.user.id, 'u1', 'pseudonymous id is kept');
  assert.equal(out.meta.page.url.split('#')[0], 'https://app.example.test/reset?email=[REDACTED]&token=[REDACTED]');
  assert.equal(item.payload.value.includes('jane.doe@example.com'), true, 'input not mutated');
  assert.equal(sdk.sanitizeUrl('https://a.test/p?q=1', true), 'https://a.test/p?q=1', 'opt-in keeps query values');
});

test('Faro config applies redaction (and the app beforeSend) to every captured event', () => {
  const plan = {
    faroEndpoint: TELEMETRY.faroEndpoint,
    browserToken: TELEMETRY.browserToken,
    samplingRatio: 1,
    resource: TELEMETRY.resource,
    propagateTo: [],
    options: { beforeSend: (item) => (item.payload.name === 'drop-me' ? null : item) },
    appName: 'shop',
    environment: 'production',
  };
  const cfg = faroMod.buildFaroConfig(plan, { id: 'v1', name: '/' });
  assert.equal(cfg.transports.length, 1);
  assert.deepEqual(cfg.transports[0].getIgnoreUrls(), [TELEMETRY.faroEndpoint]);
  assert.equal(cfg.sessionTracking.samplingRate, 1, 'sampling is decided before Faro loads');
  const names = cfg.instrumentations.map((i) => i.name).join(',');
  for (const n of ['errors', 'web-vitals', 'session', 'view', 'performance']) assert.ok(names.includes(n), `${n} instrumentation missing: ${names}`);
  const sent = cfg.beforeSend({ type: 'event', payload: { name: 'x', attributes: { q: 'password=hunter2 mail a@b.io' } }, meta: {} });
  assert.equal(sent.payload.attributes.q, 'password=[REDACTED] mail [EMAIL]');
  assert.equal(cfg.beforeSend({ type: 'event', payload: { name: 'drop-me' }, meta: {} }), null);
});

// ------------------------------------------------------------------ user actions

function el(tag, attrs = {}, parent = null, text = '') {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    className: attrs.class || '',
    parentElement: parent,
    children: [],
    innerText: text,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    matches: (sel) => !!attrs.sensitive && sel.includes('input[type="password"]'),
    closest(sel) {
      for (let n = node; n; n = n.parentElement) {
        if (sel.includes('input[type="password"]')) { if (n.matches(sel)) return n; continue; }
        if (sel.split(',').some((s) => s.trim().split(/[[.:]/)[0] === n.tagName.toLowerCase())) return n;
      }
      return null;
    },
  };
  if (parent) parent.children.push(node);
  return node;
}

test('click actions carry a selector but no text by default; sensitive fields are flagged', () => {
  const body = el('body');
  const form = el('form', { class: 'checkout' }, body);
  const btn = el('button', { class: 'btn primary extra' }, form, 'Pay jane@example.com');
  const pw = el('input', { type: 'password', sensitive: true }, form);

  const a = faroMod.clickAttributes(btn, false);
  assert.equal(a.tag, 'button');
  assert.equal(a.selector, 'body > form.checkout > button.btn.primary');
  assert.equal(a.text, undefined);

  const b = faroMod.clickAttributes(btn, true);
  assert.equal(b.text, 'Pay [EMAIL]');

  const c = faroMod.clickAttributes(pw, true);
  assert.equal(c.masked, 'true');
  assert.equal(c.text, undefined);

  const d = faroMod.clickAttributes(el('button', { id: 'save' }, form, 'Save'), false);
  assert.equal(d.selector, 'button#save');
});

// ------------------------------------------------------------------ router views + traces

test('route changes become low-cardinality views (before and after RUM starts)', async () => {
  assert.equal(sdk.normalizeRouteName('/users/42/orders/3f2c9a1e-1111-4222-8333-444455556666?tab=1'), '/users/:id/orders/:id');
  assert.equal(sdk.normalizeRouteName('/invite/jane%40example.com'), '/invite/:email');
  assert.equal(sdk.normalizeRouteName('/'), '/');

  sdk.setRumView('/checkout'); // before init: becomes the initial view
  const loader = fakeLoader();
  await sdk.initRum({ telemetry: TELEMETRY }, {}, { load: loader.load, env: fakeEnv() });
  assert.equal(loader.calls[0].initialView, '/checkout');
  sdk.setRumView('/orders/:id');
  sdk.setRumView('/');
  assert.deepEqual(loader.views, ['/orders/:id', '/']);
  sdk.stopRum();
  sdk.setRumView('/ignored'); // no RUM running: no-op, no throw
});

test('client spans are exported as OTLP with sanitized URL, session and view ids', () => {
  const plan = { appName: 'shop', environment: 'production', resource: TELEMETRY.resource, options: {} };
  const otlp = faroMod.spanToOtlp(
    { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), method: 'GET', url: 'https://api.example.test/u?email=x@y.io', startMs: 1700000000000.5, endMs: 1700000000100, status: 503, error: false },
    plan,
    { sessionId: 's1', viewId: 'v1', viewName: '/u' },
  );
  const rs = otlp.resourceSpans[0];
  const span = rs.scopeSpans[0].spans[0];
  const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
  assert.equal(span.kind, 3);
  assert.equal(span.traceId, 'a'.repeat(32));
  assert.equal(span.startTimeUnixNano, '1700000000000500000');
  assert.equal(span.status.code, 2);
  assert.equal(attrs['url.full'], 'https://api.example.test/u?email=[REDACTED]');
  assert.equal(attrs['session.id'], 's1');
  assert.equal(attrs['view.id'], 'v1');
  const res = Object.fromEntries(rs.resource.attributes.map((a) => [a.key, a.value.stringValue]));
  assert.equal(res['service.name'], 'shop');
  assert.equal(res['platform.project_id'], 'proj-1');
});
