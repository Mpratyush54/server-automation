import type { PlatformOptions } from './client';
import { setTelemetryContext } from './telemetry-context';

export interface TelemetryConfig {
  enabled: boolean;
  otlpEndpoint: string | null;
  profilesEndpoint: string | null;
  ingestToken: string;
  ingestTokenExpiresAt: string;
  samplingRatio?: number;
  resource?: Record<string, string>;
}

export function telemetryAllowed(): boolean {
  return !['false', '0', 'off'].includes((process.env.PLATFORM_OTEL_ENABLED || '').toLowerCase());
}
export function resourceAttributes(options: PlatformOptions, config: TelemetryConfig): Record<string, string> {
  let version = process.env.PLATFORM_RELEASE || options.version || process.env.APP_VERSION || process.env.OTEL_SERVICE_VERSION;
  if (!version) {
    try { version = require(require('path').join(process.cwd(), 'package.json')).version; } catch {}
  }
  const attrs: Record<string, string> = {
    'service.name': process.env.OTEL_SERVICE_NAME || options.serviceName || options.projectName,
    'service.version': version || options.commitSha || process.env.GIT_SHA || 'unknown',
    'deployment.environment': options.environmentName || 'development',
    ...config.resource,
  };
  if (process.env.PLATFORM_RELEASE) attrs['service.version'] = process.env.PLATFORM_RELEASE;
  for (const [key, env] of Object.entries({
    'k8s.namespace.name': 'K8S_NAMESPACE', 'k8s.pod.name': 'K8S_POD_NAME',
    'k8s.pod.uid': 'K8S_POD_UID', 'k8s.node.name': 'K8S_NODE_NAME',
    'k8s.container.name': 'K8S_CONTAINER_NAME', 'k8s.deployment.name': 'K8S_DEPLOYMENT_NAME',
  })) if (process.env[env]) attrs[key] = process.env[env]!;
  return attrs;
}

/** One process owns the global OTel providers. Optional modules are loaded only after opt-in. */
export class Telemetry {
  private sdk: any;
  private instrumentations: any[] = [];
  private contextManager: any;
  private profiler: any;
  private timer?: ReturnType<typeof setTimeout>;
  private config?: TelemetryConfig;
  private stopped = false;
  private relay: any;
  private active = false;
  private refreshPromise?: Promise<void>;
  constructor(private options: PlatformOptions, private fetchConfig: () => Promise<any>) {}

  async start(config?: TelemetryConfig): Promise<void> {
    if (!telemetryAllowed() || !config?.enabled) return;
    try {
      this.config = this.validate(config);
      // The bounded relay owns retry/backpressure and attaches the CURRENT ingest token,
      // including for native profilers that otherwise retain their original credentials.
      const { TelemetryRelay } = require('./telemetry-relay');
      this.relay = new TelemetryRelay(() => this.config);
      const base = await this.relay.start();
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
      const api = require('@opentelemetry/api');
      const { Resource } = require('@opentelemetry/resources');
      const { ParentBasedSampler, TraceIdRatioBasedSampler, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
      const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
      const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
      const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
      const attrs = resourceAttributes(this.options, config);
      const excluded = (process.env.PLATFORM_OTEL_EXCLUDE_ROUTES || '/health,/healthz,/ready,/readyz,/api/health').split(',').map(x => x.trim()).filter(Boolean);
      const ignore = (req: any) => {
        const path = (req.url || req.path || '').split('?')[0];
        return excluded.some(p => path === p || path.startsWith(p + '/')) ||
          (req.socket?.localPort === this.relay.port || (req.hostname === '127.0.0.1' && Number(req.port) === this.relay.port)) ||
          path.startsWith('/api/sdk/');
      };
      const instrumentationConfig: any = {};
      // Explicitly disable the rest of the 0.57 bundle before constructing instrumentors.
      const disabled = ['amqplib', 'aws-lambda', 'aws-sdk', 'bunyan', 'cassandra-driver', 'connect', 'cucumber', 'dataloader', 'dns', 'fs', 'generic-pool', 'graphql', 'grpc', 'hapi', 'kafkajs', 'knex', 'koa', 'lru-memoizer', 'memcached', 'mysql', 'mysql2', 'nestjs-core', 'net', 'oracledb', 'redis', 'redis-4', 'restify', 'router', 'socket.io', 'tedious', 'undici'];
      for (const name of disabled) instrumentationConfig['@opentelemetry/instrumentation-' + name] = { enabled: false };
      instrumentationConfig['@opentelemetry/instrumentation-http'] = { enabled: true, ignoreIncomingRequestHook: ignore, ignoreOutgoingRequestHook: ignore };
      instrumentationConfig['@opentelemetry/instrumentation-winston'] = { enabled: true, disableLogSending: true };
      instrumentationConfig['@opentelemetry/instrumentation-pino'] = { enabled: true, disableLogSending: true };
      const ratio = Number(process.env.PLATFORM_OTEL_SAMPLING_RATIO ?? config.samplingRatio ?? 1);
      const spanProcessors: any[] = [new BatchSpanProcessor(new OTLPTraceExporter({ url: base + '/v1/traces' }), { maxQueueSize: 512, maxExportBatchSize: 64 })];
      let contextManager: any;
      if (!['false', '0', 'off'].includes((process.env.PLATFORM_PROFILING_ENABLED || '').toLowerCase()) && config.profilesEndpoint) {
        try {
          const profiler = require('@pyroscope/nodejs');
          profiler.init({ appName: attrs['service.name'], serverAddress: base + '/pyroscope', tags: {
            platform_project_id: attrs['platform.project_id'] || this.options.projectName,
            deployment_environment: attrs['deployment.environment'], service_version: attrs['service.version'],
          } });
          profiler.start();
          this.profiler = profiler;
          const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
          contextManager = new class extends AsyncLocalStorageContextManager {
            with(ctx: any, fn: any, thisArg: any, ...args: any[]) {
              const span = api.trace.getSpan(ctx);
              if (!span?.isRecording()) return super.with(ctx, fn, thisArg, ...args);
              const id = span.spanContext().spanId;
              span.setAttribute('pyroscope.profile.id', id);
              let result: any;
              profiler.wrapWithLabels({ span_id: id }, () => { result = super.with(ctx, fn, thisArg, ...args); });
              return result;
            }
          }();
        } catch { /* Unsupported native profiler must not prevent tracing or application startup. */ }
      }
      this.sdk = new NodeSDK({
        resource: new Resource(attrs), autoDetectResources: false, contextManager,
        sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 1) }),
        spanProcessors,
        metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: base + '/v1/metrics' }), exportIntervalMillis: 30000 }),
        logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter({ url: base + '/v1/logs' }), { maxQueueSize: 512, maxExportBatchSize: 64 })],
        instrumentations: this.instrumentations = getNodeAutoInstrumentations(instrumentationConfig),
      });
      this.contextManager = contextManager;
      await this.sdk.start();
      this.active = true;
      const meter = api.metrics.getMeter('platform-sdk');
      meter.createObservableGauge('platform.telemetry.dropped_batches', { description: 'Batches dropped by the bounded telemetry transport' })
        .addCallback((result: any) => result.observe(this.dropped));
      meter.createObservableGauge('process.memory.usage', { unit: 'By' })
        .addCallback((result: any) => result.observe(process.memoryUsage().rss));
      const log = require('@opentelemetry/api-logs').logs.getLogger('platform-sdk');
      const severity: any = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 };
      setTelemetryContext((): Record<string, string> => {
        const sc = api.trace.getSpan(api.context.active())?.spanContext();
        return sc && api.trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
      }, (level, body, attributes) => {
        if (!this.active) return;
        // Worker transports may receive IDs injected in the originating thread.
        let context = api.context.active();
        const sc = { traceId: attributes.trace_id, spanId: attributes.span_id, traceFlags: api.TraceFlags.SAMPLED };
        if (api.trace.isSpanContextValid(sc)) context = api.trace.setSpanContext(context, sc);
        log.emit({ context, body, severityText: level, severityNumber: severity[level], attributes });
      });
      this.schedule();
    } catch {
      await this.shutdown(); // Fail open, never log endpoints or bearer tokens.
    }
  }

  private validate(config: TelemetryConfig): TelemetryConfig {
    if (!config.ingestToken || !Number.isFinite(Date.parse(config.ingestTokenExpiresAt)) || Date.parse(config.ingestTokenExpiresAt) <= Date.now()) throw new Error('Invalid telemetry credentials');
    for (const endpoint of [config.otlpEndpoint, config.profilesEndpoint].filter(Boolean)) {
      const u = new URL(endpoint!);
      if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error('Invalid collector URL');
    }
    if (!config.otlpEndpoint) throw new Error('Missing OTLP endpoint');
    return config;
  }
  private schedule(retry = false): void {
    if (this.stopped || !this.config) return;
    const remaining = Date.parse(this.config.ingestTokenExpiresAt) - Date.now();
    const delay = retry ? 5000 : Math.max(100, remaining - Math.min(60000, remaining * .1));
    this.timer = setTimeout(() => { void this.refresh(); }, Math.min(delay, 2147483647));
    this.timer.unref?.();
  }
  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const data = await this.fetchConfig();
        if (this.stopped) return;
        if (!data?.telemetry?.enabled || !telemetryAllowed()) { await this.shutdown(); return; }
        this.config = this.validate(data.telemetry);
        this.schedule();
      } catch { this.schedule(true); }
    })().finally(() => { this.refreshPromise = undefined; });
    return this.refreshPromise;
  }
  get dropped(): number { return this.relay?.dropped || 0; }
  async shutdown(): Promise<void> {
    this.stopped = true;
    this.active = false;
    setTelemetryContext();
    if (this.timer) clearTimeout(this.timer);
    try { await this.profiler?.stop(); } catch {}
    try { await this.sdk?.shutdown(); } catch {}
    for (const instrumentation of this.instrumentations) {
      try { instrumentation.disable(); } catch {}
    }
    this.instrumentations = [];
    this.contextManager?.disable();
    if (this.sdk) {
      // Allow this process to initialize again after a clean SDK shutdown.
      const api = require('@opentelemetry/api');
      api.trace.disable();
      api.metrics.disable();
      api.context.disable();
      require('@opentelemetry/api-logs').logs.disable();
    }
    await this.relay?.stop();
    this.sdk = undefined;
    this.profiler = undefined;
  }
}
