# Search logs, traces and metrics

This page helps you find out why an app is slow or failing: compare projects, follow one request through your services, search logs and see CPU use. For one project, open the project and choose **Monitoring**. For all projects, choose **Monitoring** in the sidebar.

These views need the **full** install profile (`sudo platformctl provision --profile full`) and services that use the Cairn SDK (see [Monitor real users in the browser](frontend-rum.md) for browsers). Without it the views say so. Errors, uptime checks, alerts and SLOs still work.

## Find a slow request

1. Open the project and choose **Monitoring**, view **Traces**.
2. Set **Time range** to *Last 6 hours* and, if you have several, pick the **Environment**.
3. In the endpoints table, find the route with the highest p95 (the time 95% of requests finish within). Choose **Traces** on its row.
4. Open a trace. The waterfall shows each step (span) and how long it took. Choose **Logs for this trace** to see the log lines from that request.

The time range, environment and open trace are kept in the page address, so you can share the link.

## The views

| View | What it shows |
|---|---|
| Overview | Health; requests, error rate, p95 and Apdex (a 0 to 1 score of how many requests were fast enough); active alerts, open errors and uptime status; charts with deploy markers; SLO table; links to errors, uptime, alerts and releases |
| Logs | Filters (service, level, text, trace id) or a query; **Live tail**; a **Trace** button on lines that carry a trace id |
| Traces | Service map (choose a service to filter), services table, endpoints table (top 100 by request rate); trace search by service, span name, minimum duration and status, or a query; trace waterfall with span details |
| Users | Page speed per page for real users (p75 of LCP, INP, CLS, FCP, TTFB), coloured good, needs improvement or poor; session replays; heatmaps |
| Resources | CPU and memory by pod (top 8) and container restarts for the project's environments; flame graph per service and profile type (CPU, allocated or in-use memory and objects) |

**Errors** and **Uptime** are covered in [Track and fix errors](../observability/error-tracking.md) and [Check that your site is up](../operations/synthetics.md).

### All projects

Sidebar **Monitoring** lists one row per project you can access: health, requests per second, error rate, p95, active alerts, open errors, uptime status and SLOs (total and breaching). Sort by any column. Choose a project to open its **Monitoring** overview with the same time range.

Cairn admins and DevOps users see every project. Everyone else sees projects they are a member of.

### Health

Health is worked out the same way everywhere:

| Health | When |
|---|---|
| Critical | A critical alert is open, error rate is 5% or more, or uptime checks report a major outage |
| Degraded | Any alert is open, error rate is 1% or more, an SLO is breaching, or uptime checks report a partial outage or degraded |
| No data | No error rate, no latency and no uptime status |
| Healthy | Otherwise |

### Logs and live tail

Filters build the query for you: service, environment (from the environment picker), level (matched case-insensitively against the usual level fields), text in the line, and a trace id (16 to 32 hex characters). You can also write the whole query yourself (LogQL). A metric query such as `rate(...)` returns series instead of lines, and the view says so.

**Live tail** checks every 5 seconds for newer lines and adds them on top, up to 1000 lines. The first load shows up to 300 lines.

### Traces

Search returns up to 50 traces in the portal. The waterfall only shows spans from this project's services. Spans from other projects in the same request are left out and counted (*N spans from other projects hidden*). A trace with no spans from this project shows "Trace not found". The service map labels callers or callees outside the project as **(other project)**; databases and messaging systems keep their names.

### Profiles

Profiles cover at most just under 24 hours. With *Last 7 days* the view shows *Range shortened to 23 h 59 min*. The service list uses the same range, so with *Last 15 minutes* only services profiled in the last 15 minutes are listed.

## Troubleshooting

| Message | What to do |
|---|---|
| `Observability backends are not installed (full install profile)` | Install the full profile |
| `<Backend> backend is unavailable` | The API cannot reach the backend. Check the pods in the `monitoring` namespace and the `OBSERVABILITY_*_URL` settings |
| `<Backend> backend is busy; retry shortly` | Retry |
| `<Backend> query timed out; narrow the time range or the query` | Shorten the range or simplify the query. Raise `OBSERVABILITY_QUERY_TIMEOUT_MS` if needed |
| `<Backend> response is too large; narrow the query` | Narrow the query, or raise `OBSERVABILITY_MAX_RESPONSE_BYTES` |
| `<Backend> backend rejected the query; check its syntax` | Fix the query |
| `<Backend> backend error` | See the API log (`[observability] …`) |
| `invalid since (use e.g. 15m, 1h, 24h, 7d)`, `start must be before end`, `invalid step` | Fix the parameter |
| Any error with `code: "invalid_query"` | The query cannot be limited to this project. Simplify it |
| `Too many observability queries. Retry in a minute.` | Rate limit. See [Rate limit](#rate-limit) |
| `Trace not found` | The trace does not exist, or has no spans from this project |
| Numbers show but with a red banner | Metrics were unavailable; counts from the database are still shown |

Empty tables usually mean no data: no SDK telemetry from your services, no browser monitoring (page speed), or no running environment (pod metrics).

## How it works

The views query the full profile's telemetry backends through the API: Prometheus (metrics), Loki (logs), Tempo (traces) and Pyroscope (profiles). The full profile sets `PLATFORM_OBSERVABILITY` on the API; without it the query endpoints answer 503 `observability_disabled`.

### Metric definitions

- **RED** metrics (rate, errors, duration) come from Tempo span metrics for server and consumer spans: request rate, error rate (spans with error status, %), and p50, p95 and p99 latency.
- **Apdex** uses T = 512 ms (satisfied up to 512 ms, tolerating up to 4T = 2048 ms), shown as *Apdex (T = 512 ms)*. It is computed from latency histogram buckets, so T has to be a bucket boundary: 0.512 s and 2.048 s are default Tempo span-metrics buckets, 0.5 s is not. The summary returns it as `red.apdexThresholdMs`.
- Page speed uses one Loki query per web vital.

### Project scoping

Every request checks that you are at least a **viewer** of the project. Cairn admins and DevOps users have access to all projects; agent tokens need `projects:read`. Then:

- Every PromQL, LogQL and TraceQL query, typed or built from filters, is rewritten on the server so that each selector is limited to the project. A query that tries to select another project, or that the server cannot safely rewrite, is rejected with 400 and `code: "invalid_query"`. The rewritten query is returned in the response's `query` field.
- Trace detail returns only this project's spans.
- Pod metrics use the namespaces of the project's own environments, never a namespace from the request.
- Profile selectors are built only from validated parameters.

Queries are limited to 4000 characters. Profile queries are limited to 86 340 seconds because Pyroscope refuses queries longer than its `max_query_length` of one day; the response marks a shortened range with `range.clamped: true`.

### Time ranges and limits

Every endpoint accepts `since` (`15m`, `1h`, `24h`, `7d`, …; default `1h`) or `start` and `end` (Unix seconds, milliseconds or nanoseconds, or RFC 3339). An `end` more than 5 minutes in the future is treated as now. Ranges longer than the maximum keep their end and are shortened (`range.clamped: true`). The views then show a notice such as *Range shortened to 3 d*. Trims under 1% (the 24 h to 23 h 59 min profile trim) are not shown.

| Variable | Default (allowed) | Meaning |
|---|---|---|
| `OBSERVABILITY_MAX_RANGE_HOURS` | `168` (1–2160) | Longest range a query may cover |
| `OBSERVABILITY_MAX_POINTS` | `1100` (50–11000) | Points per series; the `step` is raised to fit |
| `OBSERVABILITY_MAX_SERIES` | `500` (10–5000) | Series returned by metric queries (`truncated: true` beyond) |
| `OBSERVABILITY_MAX_LOG_LINES` | `1000` (10–5000) | Upper bound for the log `limit` (default 200 via the API) |
| `OBSERVABILITY_MAX_TRACES` | `100` (5–500) | Upper bound for the trace search `limit` (default 20 via the API) |
| `OBSERVABILITY_MAX_TRACE_SPANS` | `5000` (100–50000) | Spans returned for one trace (`truncated: true` beyond) |
| `OBSERVABILITY_MAX_RESPONSE_BYTES` | `16777216` (1–64 MiB) | Larger backend responses are refused |
| `OBSERVABILITY_QUERY_TIMEOUT_MS` | `10000` (1000–30000) | Backend request timeout |
| `OBSERVABILITY_RATE_LIMIT` | `600` (10–10000) | Requests per minute per user or agent token |
| `OBSERVABILITY_FLEET_MAX_PROJECTS` | `200` (1–2000) | Projects in the all-projects list (`truncated: true` beyond) |
| `OBSERVABILITY_LOKI_SCOPE` | `stream` | `stream`: the project id is a Loki stream label. `metadata`: it is structured metadata |
| `OBSERVABILITY_PROMETHEUS_URL` | `PROMETHEUS_URL` or `http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090` | Prometheus |
| `OBSERVABILITY_LOKI_URL` | `LOKI_URL` or `http://loki.monitoring.svc:3100` | Loki |
| `OBSERVABILITY_TEMPO_URL` | `TEMPO_URL` or `http://tempo.monitoring.svc:3200` | Tempo |
| `OBSERVABILITY_PYROSCOPE_URL` | `PYROSCOPE_URL` or `http://pyroscope.monitoring.svc:4040` | Pyroscope |

Values outside the allowed range are clamped to it.

### Rate limit

One per-user limit (default 600 requests per minute, `OBSERVABILITY_RATE_LIMIT`) covers every observability endpoint except `status`, including the all-projects list. With Redis it is shared by all API replicas. Typical portal cost per panel load: overview 2, services and endpoints 3, trace search 1, logs 1 (plus 1 every 5 seconds during live tail), pod metrics 1, profiles 2, page speed 5. Over the limit the API answers 429 and the view shows the error. Raise the variable if many people share one agent token or account.

### Error status codes

| Message | Status |
|---|---|
| Backends not installed | 503 |
| Backend unavailable, response too large, other backend error | 502 |
| Backend busy (it returned 429 or 503) | 503 |
| Query timed out | 504 |
| Query rejected, invalid parameter, `invalid_query` | 400 |
| Rate limit | 429 |
| Trace not found | 404 |
| Overview with `telemetryError` (red banner) | 200 |

## For developers / API

All endpoints need authentication. Project endpoints need project role **viewer** or higher. All except `status` share the rate limit.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/observability/status` | Backends installed? Current `maxRangeHours`, `maxLogLines`, `maxTraces` |
| `GET` | `/api/observability/fleet?since=` | Health, request rate, error rate, p95, alerts, open errors, uptime and SLOs per accessible project |
| `GET` | `/api/projects/<id>/observability/summary?since=&environment=` | RED + Apdex, alert incidents, open errors, uptime status, SLOs, health |
| `GET` | `/api/projects/<id>/observability/services?since=&environment=` | Services with request rate, error rate, p95 |
| `GET` | `/api/projects/<id>/observability/endpoints?since=&service=&environment=` | Top 100 endpoints (span names) with rate, errors, p95 |
| `GET` | `/api/projects/<id>/observability/red?since=&service=&environment=&step=` | RED time series |
| `GET` | `/api/projects/<id>/observability/service-graph?since=&environment=` | Service map nodes and edges |
| `GET` | `/api/projects/<id>/observability/infra?since=&environment=&step=` | Pod CPU and memory series, restarts |
| `GET` | `/api/projects/<id>/observability/query/prom?query=&start=&end=&step=&instant=1` | Scoped PromQL (range, or instant with `instant=1`) |
| `GET` | `/api/projects/<id>/observability/query/loki?query=&limit=&direction=&after=` | Scoped LogQL. Without `query`, built from `service`, `environment`, `level`, `search`, `traceId`. `after` is a nanosecond cursor for live tail |
| `GET` | `/api/projects/<id>/observability/query/tempo?q=&limit=` | Scoped TraceQL search. Without `q`, built from `service`, `name`, `environment`, `minDuration`, `maxDuration`, `status` (`error`, `ok`, `unset`) |
| `GET` | `/api/projects/<id>/observability/traces/<traceId>` | One trace, this project's spans only (`spans`, `hiddenSpans`, `truncated`) |
| `GET` | `/api/projects/<id>/observability/profiles/meta?since=` | Profiled services and profile types (default range 24 h, clamped under 1 day) |
| `GET` | `/api/projects/<id>/observability/query/pyroscope?profileType=&service=&environment=&since=&maxNodes=` | Flame graph (`maxNodes` default 1024, max 8192; range clamped under 1 day) |

```bash
curl -G "$API/api/projects/$PROJECT/observability/query/prom" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=sum by (service) (rate(traces_spanmetrics_calls_total[5m]))' \
  --data-urlencode 'since=6h'
```
