// Regression tests for the Angular SDK (run after `npm run build`: `npm test`).
require('@angular/compiler'); // JIT for partially compiled Angular packages under Node
const test = require('node:test');
const assert = require('node:assert/strict');
const { of } = require('rxjs');
const { HttpRequest, HttpResponse } = require('@angular/common/http');
const {
  PlatformHttpInterceptor,
  PlatformErrorHandler,
  redactSensitive,
} = require('../dist');

const config = {
  apiBase: 'https://platform.example.test',
  token: 'sdk_live_testtoken123',
  projectId: 'proj-1',
};

function fakeBackend() {
  const requests = [];
  return {
    requests,
    // Also quacks like HttpClient so a regression back to HttpClient is observable.
    post(url, body) {
      requests.push({ method: 'POST', url, body, headers: { get: () => null } });
      return of({});
    },
    handle(req) {
      requests.push(req);
      return of(new HttpResponse({ status: 200, body: {} }));
    },
  };
}

function fakeNext() {
  const requests = [];
  return {
    requests,
    handle(req) {
      requests.push(req);
      return of(new HttpResponse({ status: 200, body: {} }));
    },
  };
}

test('interceptor sends exactly one metric via HttpBackend with Bearer SDK token', () => {
  const backend = fakeBackend();
  const interceptor = new PlatformHttpInterceptor(config, backend);
  const next = fakeNext();

  interceptor.intercept(new HttpRequest('GET', '/api/things?page=1'), next).subscribe();

  assert.equal(next.requests.length, 1);
  assert.equal(backend.requests.length, 1, 'one metric, sent on HttpBackend (not through interceptors)');
  const metric = backend.requests[0];
  assert.equal(metric.method, 'POST');
  assert.equal(metric.url, 'https://platform.example.test/api/sdk/api-metrics');
  assert.equal(metric.headers.get('Authorization'), 'Bearer sdk_live_testtoken123');
  assert.equal(metric.body.route, '/api/things?page=1');
});

test('interceptor does not meter the SDK own Platform API calls (no request storm)', () => {
  const backend = fakeBackend();
  const interceptor = new PlatformHttpInterceptor(config, backend);
  const next = fakeNext();

  interceptor
    .intercept(new HttpRequest('POST', 'https://platform.example.test/api/sdk/api-metrics', {}), next)
    .subscribe();

  assert.equal(next.requests.length, 1);
  assert.equal(backend.requests.length, 0);
});

test('error handler posts bug report with Bearer SDK token and redacts secrets', () => {
  const backend = fakeBackend();
  const injector = { get: () => backend };
  const handler = new PlatformErrorHandler(config, injector);
  const origError = console.error;
  console.error = () => {};
  try {
    handler.handleError(new Error('failed with Authorization: Bearer eyJabc.def.ghi'));
  } finally {
    console.error = origError;
  }

  assert.equal(backend.requests.length, 1);
  const req = backend.requests[0];
  assert.equal(req.url, 'https://platform.example.test/api/sdk/bug-report');
  assert.equal(req.headers.get('Authorization'), 'Bearer sdk_live_testtoken123');
  assert.ok(!req.body.description.includes('eyJabc.def.ghi'), req.body.description);
});

test('redactSensitive strips bearer tokens, SDK tokens, cookies and password fields', () => {
  const out = redactSensitive(
    'ok Authorization: Bearer abc.def token=sdk_live_xyz {"password":"hunter2"} cookie: sid=123',
  );
  for (const secret of ['abc.def', 'sdk_live_xyz', 'sid=123', 'hunter2']) {
    assert.ok(!out.includes(secret), `${secret} leaked in: ${out}`);
  }
  assert.ok(out.startsWith('ok '));
});
