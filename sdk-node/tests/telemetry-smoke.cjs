const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.chdir(path.resolve(__dirname, '../..'));
const { EventEmitter } = require('node:events');
const { stripTypeScriptTypes } = require('node:module');
let options, requires = [], emissions = [], stopped = 0;
let remoteStatus = 200;
const uploads = [];
const httpsMock = { request(url, options, callback) {
 uploads.push({url: String(url), options});
 const request = new EventEmitter();
 request.destroy = () => {};
 request.end = () => queueMicrotask(() => {
  const response = new EventEmitter(); response.statusCode=remoteStatus;
  response.headers={'retry-after':'7'}; response.resume=()=>{};
  callback(response); response.emit('end');
 });
 return request;
} };
const timers = new Set();
const relay = { start: async () => 'http://127.0.0.1:1234/private', stop: async () => { stopped++; }, port: 1234, dropped: 2 };
const api = { TraceFlags: { SAMPLED: 1 }, trace: { disable() {}, getSpan: () => ({ spanContext: () => ({ traceId:'a'.repeat(32), spanId:'b'.repeat(16) }) }), isSpanContextValid: () => true, setSpanContext: ctx => ctx }, context: { disable() {}, active: () => ({}), with: (_, fn) => fn() }, metrics: { disable() {}, getMeter: () => ({ createObservableGauge: () => ({ addCallback() {} }) }) } };
class Exporter { constructor(opts) { this.options = opts; } }
const mocks = {
 './telemetry-relay': { TelemetryRelay: class { constructor() { return relay; } } },
 '@opentelemetry/sdk-node': { NodeSDK: class { constructor(opts) { options = opts; } start() {} async shutdown() {} } },
 '@opentelemetry/auto-instrumentations-node': { getNodeAutoInstrumentations: opts => [{ disable() { stopped++; } }] },
 '@opentelemetry/api': api,
 '@opentelemetry/core': { suppressTracing: ctx => ctx },
 '@opentelemetry/resources': { Resource: class { constructor(attrs) { this.attributes=attrs; } } },
 '@opentelemetry/sdk-trace-base': { ParentBasedSampler: Exporter, TraceIdRatioBasedSampler: Exporter, BatchSpanProcessor: Exporter },
 '@opentelemetry/exporter-trace-otlp-http': { OTLPTraceExporter: Exporter },
 '@opentelemetry/exporter-metrics-otlp-http': { OTLPMetricExporter: Exporter },
 '@opentelemetry/exporter-logs-otlp-http': { OTLPLogExporter: Exporter },
 '@opentelemetry/sdk-metrics': { PeriodicExportingMetricReader: Exporter },
 '@opentelemetry/sdk-logs': { BatchLogRecordProcessor: Exporter },
 '@opentelemetry/api-logs': { logs: { disable() {}, getLogger: () => ({ emit: e => emissions.push(e) }) } },
};
const context = vm.createContext({process, URL, console, Buffer,
 require(name) { requires.push(name); if (mocks[name]) return mocks[name]; return require(name); },
 setTimeout(fn, ms) { const t={fn,ms,unref(){}}; timers.add(t); return t; },
 clearTimeout(t) { timers.delete(t); },
});
const modules = new Map();
async function load(file) {
 file=path.resolve(file);
 if(modules.has(file)) return modules.get(file);
 const source=stripTypeScriptTypes(fs.readFileSync(file,'utf8'),{mode:'transform'});
 const mod=new vm.SourceTextModule(source,{context,identifier:file}); modules.set(file,mod);
 await mod.link(spec => {
  if (spec.startsWith('.')) return load(path.resolve(path.dirname(file),spec+'.ts'));
  const value = spec==='https' ? httpsMock : require(spec);
  const keys=spec==='crypto' ? ['randomBytes'] : ['default'];
  return new vm.SyntheticModule(keys,function(){for(const key of keys) this.setExport(key,key==='default'?value:value[key]);},{context});
 });
 await mod.evaluate(); return mod;
}
(async()=>{
 process.env.PLATFORM_PROFILING_ENABLED='false';
 const mod=await load('sdk-node/src/telemetry.ts');
 const ctx=modules.get(path.resolve('sdk-node/src/telemetry-context.ts')).namespace;
 const {Telemetry,resourceAttributes}=mod.namespace;
 const opts={projectName:'test-app',platformUrl:'https://platform.example.test',version:'v2'};
 const config={enabled:true,otlpEndpoint:'https://otel.example.test',profilesEndpoint:'https://otel.example.test/pyroscope',ingestToken:'plat_ingest_one',ingestTokenExpiresAt:new Date(Date.now()+300000).toISOString(),resource:{'platform.project_id':'test-project','deployment.environment':'prod'}};
 const disabled=new Telemetry(opts,async()=>({}));
 await disabled.start(); await disabled.start({...config,enabled:false});
 process.env.PLATFORM_OTEL_ENABLED='false'; await disabled.start(config);
 assert.equal(requires.length,0); assert.equal(timers.size,0);
 delete process.env.PLATFORM_OTEL_ENABLED;
 const telemetry=new Telemetry(opts,async()=>({telemetry:{...config,ingestToken:'plat_ingest_two'}}));
 await telemetry.start(config);
 assert.ok(options); assert.equal(options.resource.attributes['platform.project_id'],'test-project');
 assert.equal(options.spanProcessors[0].options.options.url,'http://127.0.0.1:1234/private/v1/traces');
 assert.equal(timers.size,1); assert.ok([...timers][0].ms < 300000);
 assert.equal(ctx.traceContext().trace_id,'a'.repeat(32));
 ctx.telemetryLog('INFO','test',ctx.traceContext()); assert.equal(emissions.length,1);
 await telemetry.refresh(); assert.equal(telemetry.config.ingestToken,'plat_ingest_two');
 await telemetry.shutdown(); assert.equal(timers.size,0); assert.equal(stopped,2);
 assert.equal(Object.keys(ctx.traceContext()).length,0);
 const realRelayModule=await load('sdk-node/src/telemetry-relay.ts');
 const {TelemetryRelay,retryDelay}=realRelayModule.namespace;
 const cfg={...config,ingestToken:'plat_ingest_rotated'};
 const transport=new TelemetryRelay(()=>cfg);
 async function batch(path) {
  transport.queue.push({path,body:Buffer.from('payload'),contentType:'application/json',attempts:0,ready:0});
  transport.bytes+=7; await transport.pump();
 }
 for(const path of ['/v1/traces','/v1/logs','/v1/metrics','/pyroscope/ingest?name=test']) {
  await batch(path); assert.equal(uploads.at(-1).options.headers.Authorization,'Bearer plat_ingest_rotated');
 }
 assert.equal(uploads.at(-1).url,'https://otel.example.test/pyroscope/ingest?name=test');
 remoteStatus=429; await batch('/v1/traces');
 assert.equal(transport.queue.length,1); assert.ok([...timers][0].ms>=6990);
 transport.queue[0].ready=0; timers.clear(); await transport.pump();
 transport.queue[0].ready=0; timers.clear(); await transport.pump();
 assert.equal(transport.queue.length,0); assert.equal(transport.dropped,1);
 cfg.ingestTokenExpiresAt='2000-01-01T00:00:00Z'; const count=uploads.length;
 await batch('/v1/traces'); assert.equal(uploads.length,count); assert.equal(transport.dropped,2);
 assert.equal(retryDelay(0,'9'),9000);
 await transport.stop();
 console.log('PASS: Node relay: current bearer auth for all signals, profile path, 429 Retry-After, bounded retries, expired token drops');
 console.log('PASS: Node TS runtime smoke: disabled imports/timers, mocked enabled exporters, resources, correlation, token refresh, shutdown');
})().catch(e=>{console.error(e);process.exitCode=1});
