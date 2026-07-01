# SDK Lifecycle

## Overview

The four SDKs (Node.js, Python, React, Angular) follow a common lifecycle pattern:

```
INIT ──► REGISTER ──► HEARTBEAT ──► TELEMETRY ──► SHUTDOWN
 │          │             │              │             │
 │     POST /api/    POST /api/    POST /api/    POST /api/
 │     sdk/register  sdk/heartbeat sdk/logs      sdk/deregister
 │                                  │
 │                             POST /api/
 │                             sdk/api-metrics
 │                                  │
 │                             POST /api/
 │                             sdk/bug-report
```

## Node.js SDK — Complete Lifecycle

### 1. Constructor

```typescript
// sdk-node/src/client.ts
export class PlatformClient {
  private http: AxiosInstance;
  private initialized = false;

  registration: RegistrationClient;
  logger: LoggerClient;          // Singleton
  metrics: MetricsClient;        // Singleton
  configClient: ConfigClient;
  storage: StorageClient;
  db: { postgres?, mongo?, redis? } = {};

  constructor() {
    this.http = axios.create({ timeout: 5000 });
    this.registration = new RegistrationClient(this.http);
    this.configClient = new ConfigClient(this.http);
    this.storage = new StorageClient(this.http);
    // logger and metrics are module-level singletons
  }
}
```

**State:** `initialized = false`, HTTP client created with 5s timeout.

### 2. init() — Validate Token & Register

```typescript
async init(options: PlatformOptions): Promise<void> {
  this.options = {
    environmentName: 'development',
    version: '1.0.0',
    branch: 'main',
    hostname: os.hostname(),
    databases: [],
    sdkToken: process.env.PLATFORM_SDK_TOKEN,
    ...options,
  };
  this.http.defaults.baseURL = this.options.platformUrl;

  // Set auth header
  if (this.options.sdkToken) {
    this.http.defaults.headers.common['Authorization'] = `Bearer ${this.options.sdkToken}`;
  }

  // Configure singletons
  this.logger.configure(this.http, this.options.projectName, ...);
  this.metrics.configure(this.http, this.options.projectName, ...);
  this.configClient.configure(...);
  this.storage.configure(...);

  // Register service
  const registrationData = await this.registration.register({...});
  // Registration creates:
  //   1. ServiceRegistration row in PostgreSQL
  //   2. DbConnection rows for each dbType
  //   3. ArgoCD Application (if repositoryUrl is set)
  //   4. K8s Deployment + Service + Ingress
  //   5. Auto-provision PostgreSQL databases

  // Load configs
  await this.configClient.loadAll();
  this.configClient.startBackgroundRefresh();  // poll every 60s

  // Start heartbeat
  this.startHeartbeat(registrationData?.id);

  // Setup DB pools
  if (this.options.databases!.includes('postgres')) {
    const creds = await this.registration.getDbCredentials(...);
    this.db.postgres = new PostgresManager(creds.postgres);
    await this.db.postgres.connect();
  }
  // ... mongo, redis ...

  this.initialized = true;  // ready=true
}
```

**What `init()` triggers on the server** (`POST /api/sdk/register` → `src/routes/sdk.ts:25-257`):

| Side Effect | Details |
|------------|---------|
| Service registration | Creates/updates `ServiceRegistration` row |
| DB connection records | Creates `DbConnection` rows for each `dbTypes` entry |
| ArgoCD Application | Creates `Application` CRD if `project.repositoryUrl` exists |
| K8s Deployment | `apps/v1` Deployment in `platform` namespace |
| K8s Service | ClusterIP service, port 80 → containerPort 3001 |
| K8s Ingress | Ingress with optional cert-manager TLS annotation (real domains) |
| Auto-DB provision | Calls `provisionPostgresDb()` for dev/staging/prod |
| SDK event | Logs `{ event: 'registration' }` to MongoDB `SdkEventModel` |

### 3. Heartbeat (30s Interval)

```typescript
// client.ts:113-155
this.heartbeatInterval = setInterval(async () => {
  const healthStatus = {
    postgres: this.db.postgres ? { status, activeCount, idleCount } : undefined,
    mongo: this.db.mongo ? { status, activeCount, idleCount } : undefined,
    redis: this.db.redis ? { status, activeCount, idleCount } : undefined,
  };

  await this.http.post('/api/sdk/heartbeat', {
    registrationId: regId,
    projectId: this.options.projectName,
    dbHealth: healthStatus,
    cpuPct: this.cpuPct,           // sampled every 10s
    memoryMb: 128 + Math.random() * 32,
    heapMb: 90,
    uptimeS: Math.floor(process.uptime()),
    environment: this.options.environmentName,
    timestamp: new Date().toISOString(),
  });
}, 15000);  // 15 seconds (not 30s as in heading — actual code uses 15s)
```

**CPU sampling** (`client.ts:158-173`):
```typescript
this.cpuSampleInterval = setInterval(async () => {
  const before = os.cpus();
  await new Promise(r => setTimeout(r, 500));
  const after = os.cpus();
  let idle = 0, total = 0;
  after.forEach((cpu, i) => {
    const idleDiff = cpu.times.idle - before[i].times.idle;
    const totalDiff = Object.values(cpu.times).reduce((a, b) => a + b, 0)
      - Object.values(before[i].times).reduce((a, b) => a + b, 0);
    idle += idleDiff;
    total += totalDiff;
  });
  this.cpuPct = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}, 10000);
```

**Server-side heartbeat handling** (`src/routes/sdk.ts:280-347`):
- Updates `ServiceRegistration.lastSeen` and `status = 'online'`
- Creates/updates `DbConnection` rows with health status
- Writes `MetricsRaw` document to MongoDB (CPU, memory, request count, latency percentiles)

### 4. Metrics — API Call Tracking

```typescript
// sdk-node/src/metrics.ts
export class MetricsClient {
  private buffer: ApiMetricEntry[] = [];
  private flushInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  // Express-compatible middleware
  middleware() {
    return (req, res, next) => {
      const startTime = process.hrtime.bigint();
      const memBefore = process.memoryUsage().heapUsed;

      res.on('finish', () => {
        const durationNs = Number(process.hrtime.bigint() - startTime);
        const route = normalizePath(req.path || req.url || '/');
        this.record({
          route,                          // normalized: /api/users/:id
          method: req.method,
          statusCode: res.statusCode,
          durationMs: Math.round(durationNs / 1_000_000),
          memoryDeltaBytes: memAfter - memBefore,
          environment: this.environment,
          timestamp: new Date().toISOString(),
        });
      });
      next();
    };
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0 || !this.http) return;
    const batch = this.buffer.splice(0);
    try {
      await this.http.post('/api/sdk/api-metrics', {
        projectId: this.projectId,
        metrics: batch,                 // up to 100 entries per batch
      });
    } catch {
      if (this.buffer.length < 500) this.buffer.unshift(...batch.slice(0, 50));
    }
  }
}
```

**Route normalization** (`normalizePath`):
```typescript
function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\?.*$/, '')
    .replace(/\/+$/, '') || '/';
}
```

**Server-side aggregation** (`GET /api/sdk/api-metrics`, `src/routes/sdk.ts:548-585`):
```typescript
const agg = await ApiMetricModel.aggregate([
  { $match: { projectId, environment } },
  { $group: {
    _id: { route: '$route', method: '$method' },
    count: { $sum: 1 },
    avgDuration: { $avg: '$durationMs' },
    errors4xx: { $sum: { $cond: [{ $and: [{ $gte: ['$statusCode', 400] }, { $lt: ['$statusCode', 500] }] }, 1, 0] } },
    errors5xx: { $sum: { $cond: [{ $gte: ['$statusCode', 500] }, 1, 0] } },
  }},
  { $addFields: {
    p50: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.50, { $size: '$durations' }] } }] },
    p95: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.95, { $size: '$durations' }] } }] },
    p99: { $arrayElemAt: ['$durations', { $floor: { $multiply: [0.99, { $size: '$durations' }] } }] },
  }},
]);
```

### 5. Logs — Console Capture & Batch Forwarding

```typescript
// sdk-node/src/logger.ts
export class LoggerClient {
  private buffer: any[] = [];
  private flushInterval: ReturnType<typeof setInterval>;

  constructor() {
    this.flushInterval = setInterval(() => this.flush(), 5000);
  }

  info(message, metadata?) { this.enqueue('INFO', message, metadata); }
  warn(message, metadata?) { this.enqueue('WARN', message, metadata); }
  error(message, metadata?) { this.enqueue('ERROR', message, metadata); }
  debug(message, metadata?) { this.enqueue('DEBUG', message, metadata); }

  private enqueue(level, message, metadata?) {
    this.buffer.push({
      projectId: this.projectName,
      environment: this.environmentName,
      serviceName: this.serviceName,
      branch: this.branch,
      commitSha: this.commitSha,
      hostname: this.hostname,
      level, message, metadata,
      timestamp: new Date().toISOString(),
    });
    if (this.buffer.length >= 50) this.flush();
  }

  private async flush() {
    const batch = this.buffer.splice(0);
    try {
      await this.http.post('/api/sdk/logs', { logs: batch });
    } catch {
      this.buffer.unshift(...batch);  // re-queue on failure
    }
  }
}
```

**Console capture** (`sdk-node/src/console-capture.ts`):
```typescript
export function captureConsole(logger: LoggerClient) {
  const originalConsole = { ...console };
  console.log = (...args) => { logger.info(args.join(' ')); originalConsole.log(...args); };
  console.warn = (...args) => { logger.warn(args.join(' ')); originalConsole.warn(...args); };
  console.error = (...args) => { logger.error(args.join(' ')); originalConsole.error(...args); };
  console.debug = (...args) => { logger.debug(args.join(' ')); originalConsole.debug(...args); };
}
```

**Server-side log processing** (`POST /api/sdk/logs`, `src/routes/sdk.ts:349-416`):

```
SDK Logs ──► LogModel.insertMany(resolvedLogs) ──► MongoDB
       │
       └──► forwardToLoki(resolvedLogs) ──► Loki (Grafana)
       │
       └──► ErrorDocModel.findOneAndUpdate(upsert) ──► MongoDB
            (only for ERROR level logs)
            - tracks occurrenceCount
            - firstSeen / lastSeen timestamps
            - dedup by projectId + errorType + stackHash
```

### 6. Bug Reports

```typescript
// SDK-side (frontend SDKs: React, Angular)
// React: <BugReporterWidget /> or useBugReporter()
// Angular: <bug-reporter-component>

await this.http.post('/api/sdk/bug-report', {
  projectId,
  environment: 'production',
  description: 'User cannot login after password reset',
  category: 'Bug',
  consoleLogs: ['[ERROR] Failed to fetch /api/auth/login', ...],
  networkTimeline: [
    { url: '/api/auth/login', status: 401, durationMs: 2300 },
    ...
  ],
  screenshotBase64: 'data:image/png;base64,...',  // optional
  browserInfo: { userAgent, screenSize, viewport },
  appState: { currentRoute: '/dashboard', ... },
});
```

**Server-side handling** (`src/routes/sdk.ts:587-618`):
```typescript
const report = await BugReportModel.create({ ... });  // MongoDB
// Fire-and-forget ClickUp integration:
(async () => {
  const project = await ds.getRepository(Project).findOne({ where: { id: body.projectId } });
  if (project?.clickupListId) {
    const taskTitle = `[BUG] ${body.category}: ${body.description.substring(0, 80)}`;
    await postComment('auto', `Bug report created:\n\n${taskTitle}`);
  }
})();
```

### 7. Shutdown

```typescript
async shutdown(): Promise<void> {
  clearInterval(this.heartbeatInterval);
  clearInterval(this.cpuSampleInterval);
  this.metrics.stop();          // flush remaining metrics
  this.configClient.stopBackgroundRefresh();
  this.logger.stop();           // flush remaining logs

  // Disconnect DB pools
  await Promise.allSettled([
    this.db.postgres?.disconnect(),
    this.db.mongo?.disconnect(),
    this.db.redis?.disconnect(),
  ]);

  // Deregister
  await this.registration.deregister(this.options.projectName, ...);
}
```

## SDK State Machine

```
                  ┌──────────────┐
                  │  CREATED     │
                  │  initialized │
                  │  = false     │
                  └──────┬───────┘
                         │ init(options)
                         ▼
                  ┌──────────────┐
                  │ INITIALIZING │
                  │  configure   │────► POST /api/sdk/register
                  │  singletons  │────► loadAll configs
                  └──────┬───────┘────► start background refresh
                         │
                         ▼
                  ┌──────────────┐
                  │  READY       │
                  │  initialized │
                  │  = true      │
                  │  heartbeat   │────► POST /api/sdk/heartbeat (every 15s)
                  │  active      │────► POST /api/sdk/api-metrics (every 5s)
                  └──────┬───────┘────► POST /api/sdk/logs (every 5s / 50 entries)
                         │
                         │ shutdown()
                         ▼
                  ┌──────────────┐
                  │ SHUTDOWN     │
                  │  stop metrics│────► POST /api/sdk/deregister
                  │  stop logger │────► disconnect DB pools
                  │  clear       │
                  │  intervals   │
                  └──────────────┘
```

## Event Flow Diagram (Per-Request)

```
HTTP Request
     │
     ▼
┌──────────────────────────────────────────────────┐
│              Express Middleware Chain             │
│                                                   │
│  metrics.middleware()                             │
│    ├─ record startTime, memBefore                 │
│    ├─ next()                                      │
│    └─ res.on('finish') ───► record endTime        │
│                              ┌──────────────────┐ │
│                              │ buffer[]          │ │
│                              │ (max 100 entries) │ │
│                              └────────┬─────────┘ │
│                                       │            │
│                          every 5s or buffer ≥ 100  │
│                                       │            │
│                                       ▼            │
│                              POST /api/sdk/        │
│                              api-metrics           │
└──────────────────────────────────────────────────┘

Console.log / logger.info
     │
     ▼
┌──────────────────────────────────────────────────┐
│  LoggerClient.enqueue()                          │
│    └─ push to buffer[]                            │
│       │ max 50 entries                            │
│       ▼                                           │
│  every 5s or buffer ≥ 50                          │
│       ▼                                           │
│  POST /api/sdk/logs                               │
│    └─ LogModel.insertMany (MongoDB)               │
│    └─ forwardToLoki (Loki)                        │
│    └─ ErrorDocModel.upsert (ERRORs only)          │
└──────────────────────────────────────────────────┘
```

## SDK Token Authentication

Two formats supported by the server (`src/middleware/auth.ts:145-183`):

| Format | Example | Validation |
|--------|---------|------------|
| **Embedded** | `sdk-{projectId}:{secret}` | Parser extracts projectId from prefix, no DB lookup |
| **Reference** | `sdk_live_{uuid}` or `sdk_test_{uuid}` | Lookup in `SdkCredential` table, checks `status = 'active'` |

```typescript
export async function sdkTokenAuth(req, res, next) {
  const token = auth.substring(7);
  if (token.startsWith('sdk-')) {
    projectId = token.split(':')[0].replace('sdk-', '');
  } else if (token.startsWith('sdk_live_') || token.startsWith('sdk_test_')) {
    const credential = await ds.getRepository('SdkCredential')
      .findOne({ where: { token, status: 'active' } });
    projectId = credential.projectId;
  }
  (req as AuthenticatedRequest).sdkToken = true;
  (req as AuthenticatedRequest).projectId = projectId;
  next();
}
```

## Cross-SDK Reference

| Capability | Node.js | Python | React | Angular |
|-----------|---------|--------|-------|---------|
| `init()` | `PlatformClient.init(options)` | `PlatformClient(options)` | `<PlatformProvider>` | `PlatformModule.forRoot()` |
| Auto-registration | POST `/api/sdk/register` | POST `/api/sdk/register` | Via Node SDK proxy | Via Node SDK proxy |
| Heartbeat | 15s interval | TBD | N/A (browser) | N/A (browser) |
| Metrics | Express middleware, buffer flush 5s | `track_metric()` | HTTP interceptor | `PlatformHttpInterceptor` |
| Logging | `logger.info()`, console capture, Winston/Pino transports | `platform.logger.info()` | `usePlatform().log()` | `PlatformModule` interceptor |
| Bug reports | `POST /api/sdk/bug-report` | `POST /api/sdk/bug-report` | `<BugReporterWidget>`, `useBugReporter()` | `<bug-reporter-component>` |
| Config | `client.config(key)` | `platform.get_config(key)` | `usePlatform().config(key)` | `PlatformService.config(key)` |
| DB credentials | `registration.getDbCredentials()` | `platform.get_db_credentials()` | N/A | N/A |
| DB managers | pg, mongo, redis pool | psycopg2, pymongo, redis | N/A | N/A |
| Shutdown | `client.shutdown()` | `platform.shutdown()` | Component unmount | Module destroy |

> See [Auth Flow](auth-flow.md) for SDK token auth details and [Data Flow](data-flow.md) for end-to-end request lifecycle.
