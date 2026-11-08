// Regression tests for the React SDK (run via `npm test`, which builds first).
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { attachMetrics, createTelemetryClient } = require('../dist/telemetry');
const { redactSensitive, maskSensitiveInputs } = require('../dist');

const config = {
  apiBase: 'https://platform.example.test',
  token: 'sdk_live_testtoken123',
  projectId: 'proj-1',
};

function recordingAdapter(calls) {
  return async (cfg) => {
    calls.push(cfg);
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config: cfg, request: {} };
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test('metrics are sent once, on the telemetry client, with the SDK bearer token (no loop)', async () => {
  const apiCalls = [];
  const telemetryCalls = [];
  const api = axios.create({ baseURL: config.apiBase, adapter: recordingAdapter(apiCalls) });
  const telemetry = createTelemetryClient(config);
  telemetry.defaults.adapter = recordingAdapter(telemetryCalls);

  attachMetrics(api, telemetry, config);
  await api.get('/api/things?token=abc');
  await flush();

  assert.equal(apiCalls.length, 1, 'metric must not be posted through the metered instance');
  assert.equal(telemetryCalls.length, 1);
  const metric = telemetryCalls[0];
  assert.equal(metric.url, '/api/sdk/api-metrics');
  assert.equal(metric.headers.Authorization, 'Bearer sdk_live_testtoken123');
  const body = JSON.parse(metric.data);
  assert.equal(body.route, '/api/things?token=[REDACTED]');
});

test('calls to /api/sdk/* through the provider client are not metered', async () => {
  const telemetryCalls = [];
  const api = axios.create({ baseURL: config.apiBase, adapter: recordingAdapter([]) });
  const telemetry = createTelemetryClient(config);
  telemetry.defaults.adapter = recordingAdapter(telemetryCalls);

  attachMetrics(api, telemetry, config);
  await api.post('/api/sdk/logs', { logs: [] });
  await flush();
  assert.equal(telemetryCalls.length, 0);
});

test('detach removes interceptors (no duplicate metrics after re-render)', async () => {
  const telemetryCalls = [];
  const api = axios.create({ baseURL: config.apiBase, adapter: recordingAdapter([]) });
  const telemetry = createTelemetryClient(config);
  telemetry.defaults.adapter = recordingAdapter(telemetryCalls);

  attachMetrics(api, telemetry, config)();
  attachMetrics(api, telemetry, config);
  await api.get('/x');
  await flush();
  assert.equal(telemetryCalls.length, 1);
});

test('redactSensitive strips bearer tokens, SDK tokens, JWTs, cookies and password fields', () => {
  const out = redactSensitive(
    'ok Authorization: Bearer abc.def sdk_test_xyz eyJa.eyJb.sig {"password":"hunter2"} cookie: sid=123',
  );
  for (const secret of ['abc.def', 'sdk_test_xyz', 'eyJa.eyJb.sig', 'hunter2', 'sid=123']) {
    assert.ok(!out.includes(secret), `${secret} leaked in: ${out}`);
  }
  assert.ok(out.startsWith('ok '));
});

test('maskSensitiveInputs blanks password fields before a screenshot', () => {
  const pw = { value: 'hunter2', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  let selector = '';
  const doc = {
    querySelectorAll(sel) {
      selector = sel;
      return [pw];
    },
  };
  assert.equal(maskSensitiveInputs(doc), 1);
  assert.ok(selector.includes('input[type="password"]'));
  assert.equal(pw.value, '');
  assert.equal(pw.attrs.value, '');
});
