import { Telemetry, resourceAttributes } from '../../src/telemetry';
import { setTelemetryContext } from '../../src/telemetry-context';
import { LoggerClient } from '../../src/logger';
import { createPinoTransport, createWinstonTransport } from '../../src/transports';
import { retryDelay } from '../../src/telemetry-relay';

const options = { projectName: 'app', platformUrl: 'https://platform.example.test', environmentName: 'dev', version: 'v2' };
const config = () => ({ enabled: true, otlpEndpoint: 'https://otel.example.test', profilesEndpoint: 'https://otel.example.test/pyroscope', ingestToken: 'plat_ingest_test', ingestTokenExpiresAt: new Date(Date.now() + 300000).toISOString(), resource: { 'platform.project_id': 'project-test', 'deployment.environment': 'production' } });

describe('telemetry lifecycle without network', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; setTelemetryContext(); jest.useRealTimers(); });

  it('leaves optional modules and timers absent for missing/disabled config and env opt-out', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn();
    const telemetry = new Telemetry(options, fetch);
    await telemetry.start();
    await telemetry.start({ ...config(), enabled: false });
    process.env.PLATFORM_OTEL_ENABLED = 'false';
    await telemetry.start(config());
    expect(jest.getTimerCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect((telemetry as any).sdk).toBeUndefined();
    expect((telemetry as any).relay).toBeUndefined();
  });

  it('uses server resource scope and downward API fields', () => {
    process.env.K8S_POD_NAME = 'pod-test';
    expect(resourceAttributes(options, config())).toMatchObject({
      'service.name': 'app', 'service.version': 'v2', 'platform.project_id': 'project-test',
      'deployment.environment': 'production', 'k8s.pod.name': 'pod-test',
    });
  });

  it('initializes enabled exporters against the private transport with mocked optional modules', async () => {
    jest.useFakeTimers();
    process.env.PLATFORM_PROFILING_ENABLED = 'false';
    const sdk = { start: jest.fn(), shutdown: jest.fn() };
    const sdkConstructor = jest.fn().mockImplementation(() => sdk);
    const traceExporter = jest.fn();
    const logExporter = jest.fn();
    const metricExporter = jest.fn();
    const emit = jest.fn();
    const relay = { start: jest.fn().mockResolvedValue('http://127.0.0.1:1234/private'), stop: jest.fn(), port: 1234, dropped: 0 };
    const virtual = (name: string, value: any) => jest.doMock(name, () => value, { virtual: true });
    jest.doMock('../../src/telemetry-relay', () => ({ TelemetryRelay: jest.fn().mockImplementation(() => relay) }));
    virtual('@opentelemetry/sdk-node', { NodeSDK: sdkConstructor });
    virtual('@opentelemetry/auto-instrumentations-node', { getNodeAutoInstrumentations: jest.fn().mockReturnValue([]) });
    virtual('@opentelemetry/api', { metrics: { disable: jest.fn(), getMeter: () => ({ createObservableGauge: () => ({ addCallback: jest.fn() }) }) }, trace: { disable: jest.fn(), getSpan: () => undefined }, context: { disable: jest.fn(), active: jest.fn() } });
    virtual('@opentelemetry/api-logs', { logs: { disable: jest.fn(), getLogger: () => ({ emit }) } });
    virtual('@opentelemetry/resources', { Resource: jest.fn() });
    virtual('@opentelemetry/sdk-trace-base', { ParentBasedSampler: jest.fn(), TraceIdRatioBasedSampler: jest.fn(), BatchSpanProcessor: jest.fn() });
    virtual('@opentelemetry/exporter-trace-otlp-http', { OTLPTraceExporter: traceExporter });
    virtual('@opentelemetry/exporter-metrics-otlp-http', { OTLPMetricExporter: metricExporter });
    virtual('@opentelemetry/exporter-logs-otlp-http', { OTLPLogExporter: logExporter });
    virtual('@opentelemetry/sdk-metrics', { PeriodicExportingMetricReader: jest.fn() });
    virtual('@opentelemetry/sdk-logs', { BatchLogRecordProcessor: jest.fn() });
    const telemetry = new Telemetry(options, jest.fn());
    try {
      await telemetry.start(config());
      expect(sdk.start).toHaveBeenCalledTimes(1);
      expect(traceExporter).toHaveBeenCalledWith({ url: 'http://127.0.0.1:1234/private/v1/traces' });
      expect(metricExporter).toHaveBeenCalledWith({ url: 'http://127.0.0.1:1234/private/v1/metrics' });
      expect(logExporter).toHaveBeenCalledWith({ url: 'http://127.0.0.1:1234/private/v1/logs' });
    } finally {
      await telemetry.shutdown();
      for (const name of ['@opentelemetry/sdk-node', '@opentelemetry/auto-instrumentations-node', '@opentelemetry/api', '@opentelemetry/api-logs', '@opentelemetry/resources', '@opentelemetry/sdk-trace-base', '@opentelemetry/exporter-trace-otlp-http', '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-logs-otlp-http', '@opentelemetry/sdk-metrics', '@opentelemetry/sdk-logs']) jest.dontMock(name);
      jest.dontMock('../../src/telemetry-relay');
      jest.resetModules();
    }
  });

  it('refreshes before expiry and atomically rotates the config', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn().mockResolvedValue({ telemetry: { ...config(), ingestToken: 'plat_ingest_rotated' } });
    const telemetry = new Telemetry(options, fetch);
    (telemetry as any).config = config();
    (telemetry as any).schedule();
    await jest.advanceTimersByTimeAsync(270001);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((telemetry as any).config.ingestToken).toBe('plat_ingest_rotated');
    await telemetry.shutdown();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries config failures and shuts down on server revocation', async () => {
    jest.useFakeTimers();
    const fetch = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ telemetry: { enabled: false } });
    const telemetry = new Telemetry(options, fetch);
    (telemetry as any).config = config();
    await telemetry.refresh();
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((telemetry as any).stopped).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects expired/insecure configurations without installing anything', async () => {
    for (const overrides of [{ ingestTokenExpiresAt: '2000-01-01T00:00:00Z' }, { otlpEndpoint: 'http://otel.example.test' }]) {
      const telemetry = new Telemetry(options, jest.fn());
      await telemetry.start({ ...config(), ...overrides });
      expect((telemetry as any).sdk).toBeUndefined();
    }
  });

  it('correlates SDK, Winston and Pino logs at enqueue time and emits OTLP logs', () => {
    const log = new LoggerClient();
    const http: any = { post: jest.fn().mockResolvedValue({}) };
    log.configure(http, 'app', 'prod', 'app');
    const ids = { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) };
    const emit = jest.fn();
    setTelemetryContext(() => ids, emit);
    log.record('INFO', 'sdk');
    createWinstonTransport(log).log({ message: 'winston', level: 'info' }, () => {});
    createPinoTransport(log).write(JSON.stringify({ msg: 'pino', level: 30 }));
    setTelemetryContext();
    for (const entry of (log as any).buffer) {
      expect(entry).toMatchObject(ids);
      expect(entry.metadata).toMatchObject(ids);
    }
    expect(emit).toHaveBeenCalledTimes(3);
    log.stop();
  });

  it('honors Retry-After seconds and dates, with bounded jitter otherwise', () => {
    expect(retryDelay(0, '7')).toBe(7000);
    expect(retryDelay(0, 'Wed, 01 Jan 2031 00:00:00 GMT', Date.parse('2030-12-31T23:59:55Z'))).toBe(5000);
    expect(retryDelay(0)).toBeGreaterThanOrEqual(500);
    expect(retryDelay(0)).toBeLessThanOrEqual(1500);
  });
});

let otelAvailable = false;
try { require.resolve('@opentelemetry/sdk-trace-base'); otelAvailable = true; } catch {}
(otelAvailable ? it : it.skip)('exports an in-memory span with platform resource and correlates active context', async () => {
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { Resource } = require('@opentelemetry/resources');
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const api = require('@opentelemetry/api');
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ resource: new Resource(resourceAttributes(options, config())) });
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  const manager = new AsyncLocalStorageContextManager().enable();
  api.context.setGlobalContextManager(manager);
  const log = new LoggerClient();
  log.configure({ post: jest.fn().mockResolvedValue({}) } as any, 'app', 'prod', 'app');
  setTelemetryContext((): Record<string, string> => {
    const span = api.trace.getSpan(api.context.active());
    return span ? { trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId } : {};
  });
  provider.getTracer('test').startActiveSpan('query', (span: any) => {
    log.record('INFO', 'query');
    expect((log as any).buffer[0].trace_id).toBe(span.spanContext().traceId);
    span.end();
  });
  expect(exporter.getFinishedSpans()[0].resource.attributes['platform.project_id']).toBe('project-test');
  setTelemetryContext(); log.stop();
  await provider.shutdown(); manager.disable(); api.context.disable();
});
