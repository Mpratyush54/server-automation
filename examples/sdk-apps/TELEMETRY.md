# Backend telemetry examples

Requires a full-profile platform with the collector from #37 and SDK config/token issuance
from #49. Standard/minimal installations and older APIs remain on legacy SDK logging/metrics.
The SDKs read the **top-level `telemetry` block** of `GET /api/sdk/config`; they never infer
collector URLs or use the SDK API token for ingestion. OTLP uses `otlpEndpoint` plus
`/v1/traces`, `/v1/metrics`, `/v1/logs`; profiling uses `profilesEndpoint` plus `/ingest`.
Both use `Authorization: Bearer <ingestToken>`, refreshed before `ingestTokenExpiresAt`.
Endpoints must use HTTPS; local collector tests should mock config/exporters.

## Node

Build `sdk-node` and install the optional telemetry peers in the application:

```sh
cd sdk-node
npm ci --omit=peer
npm run build
# Install the compatible optional peer set into the example application:
cd ../examples/sdk-apps/node-api
npm install
npm install @opentelemetry/sdk-node@^0.57.2 @opentelemetry/auto-instrumentations-node@^0.57.0 \
  @opentelemetry/api@^1.9.0 @opentelemetry/api-logs@^0.57.2 \
  @opentelemetry/resources@^1.30.1 @opentelemetry/core@^1.30.1 \
  @opentelemetry/sdk-trace-base@^1.30.1 @opentelemetry/context-async-hooks@^1.30.1 \
  @opentelemetry/sdk-metrics@^1.30.1 @opentelemetry/sdk-logs@^0.57.2 \
  @opentelemetry/exporter-trace-otlp-http@^0.57.2 \
  @opentelemetry/exporter-metrics-otlp-http@^0.57.2 \
  @opentelemetry/exporter-logs-otlp-http@^0.57.2 @pyroscope/nodejs@^0.4.0
npm start
```

Set the existing demo's `PLATFORM_URL`, `PLATFORM_SDK_TOKEN` and project configuration
as described in [README](README.md). It awaits `platform.init()` before requiring Express,
and `/api/db-check` makes PostgreSQL, MongoDB and Redis calls inside the HTTP trace.
HTTP, Express, Fastify, pg, mongodb, ioredis, Winston and Pino are selected automatically.
Winston/Pino auto-instrumentation injects context in the original log records; the SDK
transports and SDK logger preserve `trace_id` / `span_id` when forwarding legacy and OTLP logs.
Pino destinations running in a worker must receive IDs injected in the originating thread.

For an application using a preload, `--require` starts asynchronous initialization. **Await
the exported `ready` promise before loading application code**; `--require` alone cannot
wait for the platform config response:

```sh
PLATFORM_PROJECT_NAME=my-app PLATFORM_URL=https://platform.example.test \
node --require @mpratyush54/sdk-node/dist/register.js -e \
  'require("@mpratyush54/sdk-node/dist/register.js").ready.then(() => require("./app.cjs"))'
```

Use one SDK instance/init per process. On SIGTERM, await `platform.shutdown()`. For ESM,
call `await platform.init(...)` then `await import('./app.js')`; ordinary static imports
are evaluated before initialization and cannot be auto-instrumented reliably.

## Python

```sh
cd examples/sdk-apps/python-api
python -m pip install -r requirements.txt
PLATFORM_URL=https://platform.example.test PLATFORM_SDK_TOKEN=... python app.py
```

Provide PostgreSQL credentials via `PLATFORM_PG_*` (see sdk-python README); no credentials
are embedded in this example. `init()` must precede Flask/FastAPI/Django and DB imports.
The telemetry extra selects requests, Flask, FastAPI, Django, psycopg/psycopg2, pymongo and
redis instrumentation. Only installed application libraries are instrumented. Standard
Python logging exports through an OTel handler, with active trace IDs. `platform.log()`
also retains its existing API behavior and forwards the same correlation fields.
In Gunicorn, initialize in each worker after the final fork; do not preload a running profiler.

## Controls and resources

| Variable | Behavior |
| --- | --- |
| `PLATFORM_OTEL_ENABLED=false` (also `0`, `off`) | No optional OTel/profiler imports, hooks, listener, export workers or telemetry refresh timers. Existing SDK registration, logs, metrics and heartbeat remain operational. |
| `PLATFORM_PROFILING_ENABLED=false` | Keep OTel; omit native profiler and span/profile bridge. |
| `PLATFORM_OTEL_SAMPLING_RATIO` | Root trace ratio, clamped 0–1; defaults to config `samplingRatio`, then 1.0. Parent sampling is preserved. |
| `PLATFORM_OTEL_EXCLUDE_ROUTES` | Comma-separated literal path prefixes; defaults `/health,/healthz,/ready,/readyz,/api/health`. Query strings do not prevent matching. |
| `OTEL_SERVICE_NAME`, `APP_VERSION`, `OTEL_SERVICE_VERSION`, `GIT_SHA` | Service identity/version (Node also reads the app package.json; Python accepts `version`/`commit_sha` in init). |
| `K8S_NAMESPACE`, `K8S_POD_NAME`, `K8S_POD_UID`, `K8S_NODE_NAME`, `K8S_CONTAINER_NAME`, `K8S_DEPLOYMENT_NAME` | Optional downward API values mapped to `k8s.*` resource attributes. |

The config's `resource` supplies `platform.project_id` and `deployment.environment`.
The collector remains authoritative for both. Profilers use label-safe names
`platform_project_id`, `deployment_environment`, `service_version`; for profiles the
ingest proxy replaces the first two from the token and stores the service as
`<project-id>/<service>`. Node's scoped profiling
bridge tags samples with `span_id` and spans with `pyroscope.profile.id`; Python uses
`pyroscope-otel`. Node scoped labels cover execution in an active OTel context; asynchronous
work may need an explicit child span for useful attribution. Profilers unsupported on an
OS are skipped without preventing traces. Missing telemetry peers fail open.

Only enabled telemetry creates a private loopback listener, with a random unguessable
path, to bridge native profiler uploads and OTLP exporters to the current bearer token.
It accepts only known ingest routes, never redirects credentials, and rejects expired
tokens. Its FIFO buffer is bounded to 16 batches / 8 MiB (plus capped incoming requests),
one remote request at a time, three attempts, five-second request timeout. On 429 it honors
Retry-After (seconds or HTTP date); other transient failures use exponential jitter.
Permanent failures, overflow and shutdown drops increment `platform.telemetry.dropped_batches`.
OTel trace/log batch queues are separately capped at 512 records with 64-record batches.
Application threads never wait for collector uploads. Shutdown flushes providers into the
transport, then drops any remaining remote backlog rather than waiting indefinitely.

`/api/sdk/api-metrics` and `expressMiddleware()` remain compatible. Their custom metrics
are deprecated for new integrations in favor of collector span metrics; existing dashboards
can continue to consume them. Do not enable a second OTel distro/provider in the same process.

## Full-profile VM verification (requires deployed #37 and #49)

1. Provision a fresh Ubuntu 24.04 VM (4 vCPU / 8 GB) with `sudo platformctl provision --profile full`.
2. Deploy both apps with project-scoped SDK tokens, DB credentials and downward API env values.
   Budget each demo initially at requests 100m CPU / 128Mi and limits 500m / 512Mi; tune with load.
3. Generate requests to `/api/db-check` and `/health` for at least two minutes.
4. Query Tempo for `{ resource.platform.project_id = "<project>" }`; inspect HTTP and DB child
   spans. Query Loki by project and a returned `trace_id`; confirm the same `span_id` in logs.
5. In Pyroscope, query `platform_project_id` and `deployment_environment`; follow the Tempo
   span's `pyroscope.profile.id` link. Observe memory/CPU before choosing production limits.
6. Shorten token TTL in a test platform, confirm exports continue after refresh and that no
   SDK-token Authorization header reaches the collector. Inject 429 with Retry-After and
   observe bounded memory and the drop gauge during a sustained outage.
7. Repeat with `PLATFORM_OTEL_ENABLED=false`, then with `telemetry` absent/disabled: no
   collector traffic, profiler, optional package imports, telemetry workers or listener.

This is a VM verification checklist, not a claim of a completed E2E run in the Windows sandbox.
