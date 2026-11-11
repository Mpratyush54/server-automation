# Telemetry ingestion (collector auth and the Redis Streams queue)

Issue #49. High-volume telemetry (OTLP traces/logs/metrics, browser RUM, profiles) goes
straight to the collector (Grafana Alloy at `otel.<DOMAIN>`, installed with the full
profile by #37). The platform API only issues short-lived ingest tokens and answers the
collector Ingress's auth subrequest. The legacy SDK endpoints that still post to the API
are queued in Redis Streams and forwarded by the leader, off the request path.

```
SDK ──GET /api/sdk/config──▶ API  (telemetry block: endpoints + ingest tokens)
SDK ──OTLP/Faro/profiles──▶ ingress-nginx (otel.<DOMAIN>) ──auth-url──▶ API /api/telemetry/ingest-auth
                                   │ 200 + X-Platform-Project-Id / X-Platform-Environment
                                   ▼
                                 Alloy (resource attrs platform.project_id / deployment.environment)

SDK ──POST /api/sdk/logs, /logs/ingest, /sdk/api-metrics, /sdk/heartbeat──▶ API
        validate + bind to the token's project ─▶ XADD plat:api:telemetry:ingest ─▶ 202
        leader: consumer group telemetry-forwarders ─▶ PII scrub (#47) ─▶ MongoDB / Loki ─▶ XACK + XDEL

Privacy (#47): Alloy `pii_scrub` on OTLP/Faro logs+traces; API `lib/pii-scrub.ts` on
SDK log ingest; consent hooks at `/api/sdk/privacy/*` for session replay (#40).
See docs/operations/telemetry-privacy.md.
```

## `telemetry` block of `GET /api/sdk/config`

```json
"telemetry": {
  "enabled": true,
  "otlpEndpoint": "https://otel.<DOMAIN>",
  "faroEndpoint": "https://otel.<DOMAIN>/collect",
  "profilesEndpoint": "https://otel.<DOMAIN>/pyroscope",
  "ingestToken": "plat_ingest_...", "ingestTokenExpiresAt": "ISO-8601",
  "browserToken": "plat_ingest_web_...",
  "samplingRatio": 1.0,
  "resource": { "platform.project_id": "...", "deployment.environment": "..." }
}
```

`enabled` is `false` and every endpoint and token is `null` unless the observability
backend is installed. SDKs then do nothing. `deployment.environment` is the environment
named by the `environmentId` query parameter (UUID or name; default `development`).

`browserToken` is `null` when the project has no browser origins. Allowed origins are
`https://<environment host>`, `https://<project domain>`, plus the project config key
`TELEMETRY_ALLOWED_ORIGINS` (comma or space separated, e.g.
`https://shop.example.com, https://*.preview.example.com, http://localhost:4200`).
The origins are signed into the token, so a change applies at the next config refresh.
The API also publishes the union of all projects' origins as the Faro receiver's CORS
allow-list (`monitoring/telemetry-origins`, see
[operations/telemetry](../operations/telemetry.md)); that list is refreshed within a
couple of minutes of a change.

## Ingest tokens

* `plat_ingest_<payload>.<sig>`: server SDKs. Valid on `/v1/traces`, `/v1/logs`,
  `/v1/metrics` and `/pyroscope/*`.
* `plat_ingest_web_<payload>.<sig>`: browser SDKs. Valid only on `/collect` (Faro),
  and only with an allowed `Origin`.
* Payload: base64url JSON `{v, typ, pid, env, iat, exp, o?}`. Signature: HMAC-SHA256
  with a key derived from `TELEMETRY_INGEST_SIGNING_KEY`. Verification is constant time.
  It needs no database or Redis lookup.
* Default lifetime is 24 h (`TELEMETRY_INGEST_TOKEN_TTL_SECONDS`). `iat` is aligned to an
  hour, so repeated config fetches return the same token (good for the auth cache). SDKs
  refresh before `ingestTokenExpiresAt`.
* Ingest tokens never authenticate against the API (`expressAuthenticate` and
  `sdkTokenAuth` refuse them).
* Signing key: generated on first boot and stored as `TELEMETRY_INGEST_SIGNING_KEY` in
  the `platform-credentials` Secret. The write is a compare-and-swap on resourceVersion,
  so every replica ends up with the same key. That Secret is envFrom'd into the API and
  included in `platformctl backup`. To rotate it, move the old value to
  `TELEMETRY_INGEST_SIGNING_KEY_PREVIOUS` (still accepted for verification), set a new
  key and restart the API. Outstanding tokens stay valid until they expire.
* Revoking an SDK token does not revoke ingest tokens already issued from it. They expire
  within the TTL.

## `/api/telemetry/ingest-auth` (ingress-nginx external auth)

Any HTTP method. Inputs: `Authorization: Bearer <ingest token>`, plus the headers
ingress-nginx adds: `X-Original-URL` (used for the path scope check), `X-Original-Method`
and the client's `Origin`.

| Result | When |
|---|---|
| `200` + `X-Platform-Project-Id`, `X-Platform-Environment`, `Cache-Control: private, max-age≤60` | valid token, right scope (and origin for browser tokens) |
| `200` without headers | credential-less CORS preflight (`X-Original-Method: OPTIONS`) to `/collect` |
| `401` (`Cache-Control: no-store`, JSON `reason`) | missing, malformed, forged or expired token; wrong scope; origin not allowed |
| `429` + `Retry-After` | the token exceeded `TELEMETRY_INGEST_AUTH_RATE_LIMIT` (server, default 600/min) or `TELEMETRY_INGEST_AUTH_WEB_RATE_LIMIT` (browser, default 300/min). Redis-backed and shared by replicas. |
| `503` + `Retry-After` | signing key temporarily unavailable |
| `403` + `X-Platform-Auth-Status: 429` or `503`, `Retry-After`, `X-Platform-Allowed-Origin` (browser tokens) | the two cases above when called as `?errors=mapped` (the platformctl Ingress). nginx `auth_request` only passes 401/403 through (anything else becomes a 500), so the Ingress maps this 403 back to a real 429/503 with `Retry-After` and CORS headers. See [operations/telemetry](../operations/telemetry.md). |

Ingress annotations for the collector (owned by #37):

```yaml
nginx.ingress.kubernetes.io/auth-url: http://platform-api.platform.svc.cluster.local:3000/api/telemetry/ingest-auth?errors=mapped
nginx.ingress.kubernetes.io/auth-response-headers: X-Platform-Project-Id,X-Platform-Environment
# Origin must be part of the cache key, or a cached browser-token success would also
# apply to other origins.
nginx.ingress.kubernetes.io/auth-cache-key: '$http_authorization|$http_origin|$request_uri'
nginx.ingress.kubernetes.io/auth-cache-duration: '200 60s'
# Maps 403 + X-Platform-Auth-Status to 429/503 with Retry-After (full text in
# platformctl/internal/manifests/data/telemetry-ingress.yaml).
nginx.ingress.kubernetes.io/configuration-snippet: |
  auth_request_set $telemetry_auth_status $upstream_http_x_platform_auth_status;
  auth_request_set $telemetry_retry_after $upstream_http_retry_after;
  auth_request_set $telemetry_cors_origin $upstream_http_x_platform_allowed_origin;
  error_page 403 = @telemetry_auth_retry;
```

Only successful auth answers are cached, so a throttled token is re-checked on
every request.

## API ingest queue

* Producers (every replica) XADD to `plat:api:telemetry:ingest` with `MAXLEN ~
  TELEMETRY_QUEUE_MAXLEN` and answer `202 {…, queued: true}`. Validation and project
  binding still happen synchronously (400/401/403 as before).
* Backpressure: when the backlog (`XLEN`; forwarded entries are deleted) is at or above
  `TELEMETRY_QUEUE_MAX_BACKLOG`, the API answers `429` with `Retry-After`
  (`TELEMETRY_QUEUE_RETRY_AFTER_SECONDS`). A payload above `TELEMETRY_QUEUE_MAX_EVENT_BYTES`
  gets `413`.
* Consumer: the `telemetry-consumer` leader job (every 1 s, on the `platform-api-leader`
  Lease holder only). It reads batches with `XREADGROUP` (group `telemetry-forwarders`),
  writes one insert per destination per batch, then XACK + XDEL. If a batch fails, each
  event is retried alone. Failed events stay pending and are picked up again by
  `XAUTOCLAIM` after `TELEMETRY_QUEUE_RECLAIM_IDLE_MS`. The same path lets a new leader
  pick up what a dead leader left pending. After `TELEMETRY_QUEUE_MAX_ATTEMPTS` deliveries
  an event is dropped and counted. Delivery is at-least-once.
* Without Redis (`PLATFORM_STATE_STORE=memory`, tests) or with `TELEMETRY_QUEUE=off`,
  events are processed inline and return the old status codes (201/200). If Redis fails
  on enqueue, the API also processes the event inline, so nothing is lost.
* Redis ACL: the API's `plat-api` user already covers stream commands (`+@read +@write`
  on `plat:api:*`).

### Metrics

Appended to `GET /api/metrics/jobs` (DevOps role, Prometheus text). Counters are per pod:
scrape every pod and sum.

| Metric | Type |
|---|---|
| `platform_telemetry_queue_depth` | gauge: events not yet forwarded |
| `platform_telemetry_queue_pending` | gauge: delivered, not yet acked |
| `platform_telemetry_queue_lag_seconds` | gauge: age of the oldest queued event |
| `platform_telemetry_events_enqueued_total` / `_inline_total` / `_rejected_total` / `_processed_total` | counters |
| `platform_telemetry_event_failures_total` | counter: failed forwarding attempts (retried) |
| `platform_telemetry_events_dropped_total{reason}` | counter: `max_attempts`, `too_large`, `malformed`, `trimmed` |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PLATFORM_OBSERVABILITY` | unset (off) | `enabled` (or true/1/yes/on/full) when the collector is installed. platformctl sets it for the full profile (#37). |
| `TELEMETRY_COLLECTOR_URL` | – | Public collector base URL (overrides the host below). |
| `OTEL_COLLECTOR_HOST` | `otel.<DOMAIN>` | Collector host (https). |
| `TELEMETRY_SAMPLING_RATIO` | `1.0` | Sampling ratio handed to SDKs. |
| `TELEMETRY_INGEST_TOKEN_TTL_SECONDS` | `86400` | Ingest token lifetime (min 300). |
| `TELEMETRY_INGEST_SIGNING_KEY` / `_PREVIOUS` | generated | HMAC key (≥ 32 chars) / previous key during rotation. |
| `TELEMETRY_INGEST_AUTH_RATE_LIMIT` / `TELEMETRY_INGEST_AUTH_WEB_RATE_LIMIT` | `600` / `300` | ingest-auth calls per minute per token. |
| `TELEMETRY_QUEUE` | `redis` | `off` = inline processing. |
| `TELEMETRY_QUEUE_MAX_BACKLOG` | `50000` | 429 threshold. |
| `TELEMETRY_QUEUE_MAXLEN` | `200000` | XADD MAXLEN ~ cap. |
| `TELEMETRY_QUEUE_RETRY_AFTER_SECONDS` | `5` | Retry-After on 429. |
| `TELEMETRY_QUEUE_MAX_EVENT_BYTES` | `1048576` | 413 above this. |
| `TELEMETRY_QUEUE_MAX_ATTEMPTS` | `5` | Deliveries before an event is dropped. |
| `TELEMETRY_QUEUE_BATCH_SIZE` | `200` | Entries per XREADGROUP. |
| `TELEMETRY_QUEUE_RECLAIM_IDLE_MS` | `30000` | Pending entries idle this long are re-claimed. |
| `TELEMETRY_QUEUE_DRAIN_BUDGET_MS` | `3000` | Time budget of one consumer run. |

## Load test (acceptance: p95 within 20 % under a flood)

`scripts/telemetry-flood.mjs` is not run in CI. To run it on a fresh Ubuntu 24.04 VM
(4 vCPU / 8 GB) after `sudo platformctl provision --profile full`:

1. Create a throwaway project in the portal and an SDK token for it (Project → Tokens).
2. Run the script from a second machine, or from the VM itself, so the network path is
   realistic (Node 20+):

   ```bash
   PLATFORM_URL=https://platform.<domain> SDK_TOKEN=sdk_live_… PROJECT_ID=<uuid> \
   PROBE_PATH=/api/projects PROBE_TOKEN=<portal JWT> \
   DURATION=60 FLOOD_CONCURRENCY=50 BATCH=100 node scripts/telemetry-flood.mjs
   ```

3. It prints p50/p95/p99 for the baseline and flood phases, the p95 ratio (exit code 1
   above `MAX_P95_RATIO`, default 1.2) and the ingest status counts (202 queued,
   429 backpressure).
4. While it runs, watch `GET /api/metrics/jobs`: `platform_telemetry_queue_depth` should
   stay below `TELEMETRY_QUEUE_MAX_BACKLOG`, and `platform_telemetry_events_dropped_total`
   should stay empty under normal load. Then check that the logs arrived (portal Logs
   view, or Loki `{project_id="<uuid>"}`).
