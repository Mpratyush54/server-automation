# Observability views

The portal has two observability views built on the platform's telemetry backends
(Prometheus, Loki, Tempo and Pyroscope):

- **Fleet** — **Observability** in the sidebar (`/observability`): one row per project you can
  access.
- **Project** — **Project → Observability** (`/projects/<id>/observability`): tabs for one
  project's metrics, traces, logs, profiles and related signals.

Traces, logs, metrics and profiles need the full install profile
(`platformctl provision --profile full`, which sets `PLATFORM_OBSERVABILITY`) and services
instrumented with the platform SDK (see [Frontend RUM](frontend-rum.md) for browsers). Without
it the portal shows *Telemetry is not enabled on this platform*; alerts, errors, synthetics and
SLOs still show, and the query endpoints answer 503 `observability_disabled`.

## Fleet view

For each project: health, requests per second, error rate, p95 latency, active alerts, open
errors, synthetics status and SLOs (total / breaching). Sort by any column; click a row to open
the project view with the same time range.

Platform admins and global DevOps users see every project; everyone else sees only projects
they are a member of. At most `OBSERVABILITY_FLEET_MAX_PROJECTS` projects are listed (default
`200`; the response sets `truncated: true` when there are more).

**Health** is worked out the same way in both views:

| Health | When |
|---|---|
| Critical | A critical alert incident is open, error rate ≥ 5 %, or synthetics report a major outage |
| Degraded | Any alert incident is open, error rate ≥ 1 %, an SLO is breaching, or synthetics report a partial outage or degraded |
| No data | No error rate, no latency and no synthetics status |
| Healthy | Otherwise |

## Project view

Pick the **time range** (15 minutes to 7 days; default 1 hour) and, if the project has several
environments, an **environment**. Tab, range, environment and an open trace are kept in the URL,
so links can be shared.

| Tab | What it shows |
|---|---|
| Overview | Health; requests, error rate, p95 and Apdex; active alerts, open errors and synthetics status; charts of requests, error rate and p95 with deploy markers; SLO table; links to errors, synthetics, alerting and releases |
| APM | Service map (click a node to filter), services table, endpoints table (top 100 by request rate) with a link to that endpoint's traces |
| Traces | Search by service, span name, minimum duration and status, or write TraceQL. Opening a trace shows a waterfall with span details, attributes and events, and a **Logs for this trace** link |
| Logs | Filters (service, level, text, trace id) or LogQL; **Live tail**; a **Trace** button on lines that carry a trace id |
| Errors | Open issues and regressions, link to [error tracking](../observability/error-tracking.md) |
| RUM | p75 web vitals (LCP, INP, CLS, FCP, TTFB) per page, coloured good / needs improvement / poor |
| Sessions | Link to session replays when that feature is installed |
| Synthetics | Overall synthetics status, links to [synthetic checks](../operations/synthetics.md) and alerting |
| Infra | CPU and memory by pod (top 8) and container restarts in the range, for the project's environment namespaces |
| Profiles | Flame graph per service and profile type (CPU, allocated / in-use memory and objects) |

Metric definitions:

- **RED** metrics come from Tempo span metrics for server and consumer spans: request rate,
  error rate (spans with error status, %), and p50 / p95 / p99 latency.
- **Apdex** uses T = 512 ms (satisfied ≤ 512 ms, tolerating ≤ 4T = 2048 ms), shown as
  *Apdex (T = 512 ms)*. It is computed from latency histogram buckets, so T has to be a bucket
  boundary: 0.512 s and 2.048 s are default Tempo span-metrics buckets, 0.5 s is not. The
  summary returns it as `red.apdexThresholdMs`.
- The service map labels callers or callees outside the project as **(other project)**;
  databases and messaging systems keep their names.

### Logs and live tail

Filters build the query for you: service, environment (from the environment picker), level
(matched case-insensitively against the usual level fields), text contained in the line, and
a trace id (16–32 hex characters). In LogQL mode you write the whole query; a metric query
(e.g. `rate(...)`) returns series instead of lines, and the Logs tab says so.

**Live tail** polls every 5 seconds for lines newer than the newest one shown and adds them on
top (up to 1000 lines in the view). The first load shows up to 300 lines.

### Traces

Filter search returns up to 50 traces in the portal. The waterfall only contains spans emitted
by this project's services; spans from other projects in the same distributed trace are left
out and counted (*N spans from other projects hidden*). A trace with no spans from this
project returns "Trace not found". The root service name in search results is shown only when
it is one of this project's services.

### Profiles

Profile queries are limited to just under 24 hours (86 340 s), because Pyroscope refuses
queries longer than its `max_query_length` of one day. A longer range keeps its end time and is
shortened; the response marks it with `range.clamped: true`. The service list
(`profiles/meta`) uses the same range as the flame graph, so with *Last 15 minutes* only services
profiled in the last 15 minutes are listed. With *Last 7 days* the Profiles tab shows *Range
shortened to 23 h 59 min*.

## Project scoping

Every request checks that you are at least a **viewer** of the project (platform admins and
global DevOps users have access to all projects; agent tokens need `projects:read`). Then:

- Every PromQL, LogQL and TraceQL query you send — typed or built from filters — is rewritten
  on the server so that each selector is restricted to the project. You cannot widen it: a
  query that tries to select another project, or that the server cannot safely rewrite, is
  rejected with 400 and `code: "invalid_query"`. The rewritten query is echoed back in the
  response's `query` field.
- Trace detail returns only this project's spans (see [Traces](#traces)).
- Infra metrics use the namespaces of the project's own environments, never a namespace taken
  from the request.
- Profile selectors are built only from validated parameters.

Queries are limited to 4000 characters.

## Time ranges and limits

Every endpoint accepts `since` (`15m`, `1h`, `24h`, `7d`, …; default `1h`) or `start` / `end`
(Unix seconds, milliseconds or nanoseconds, or RFC 3339). An `end` more than 5 minutes in the
future is treated as now. Ranges longer than the maximum keep their end and are shortened
(`range.clamped: true`). The Overview, Traces, Logs, Infra and Profiles tabs then show a notice
such as *Range shortened to 3 d*; trims of under 1 % (the 24 h → 23 h 59 min profile trim) are
not called out.

| Variable | Default | Meaning |
|---|---|---|
| `OBSERVABILITY_MAX_RANGE_HOURS` | `168` (7 days; 1–2160) | Longest range a query may cover |
| `OBSERVABILITY_MAX_POINTS` | `1100` (50–11000) | Points per series; the `step` is raised to fit |
| `OBSERVABILITY_MAX_SERIES` | `500` (10–5000) | Series returned by metric queries (`truncated: true` beyond) |
| `OBSERVABILITY_MAX_LOG_LINES` | `1000` (10–5000) | Upper bound for the log `limit` (default 200 via API) |
| `OBSERVABILITY_MAX_TRACES` | `100` (5–500) | Upper bound for the trace search `limit` (default 20 via API) |
| `OBSERVABILITY_MAX_TRACE_SPANS` | `5000` (100–50000) | Spans returned for one trace (`truncated: true` beyond) |
| `OBSERVABILITY_MAX_RESPONSE_BYTES` | `16777216` (1–64 MiB) | Larger backend responses are refused |
| `OBSERVABILITY_QUERY_TIMEOUT_MS` | `10000` (1000–30000) | Backend request timeout |
| `OBSERVABILITY_RATE_LIMIT` | `600` (10–10000) | Observability requests per minute per user (or agent token), shared by all observability endpoints except `status` (see [Rate limit](#rate-limit)) |
| `OBSERVABILITY_FLEET_MAX_PROJECTS` | `200` (1–2000) | Projects in the fleet view |
| `OBSERVABILITY_LOKI_SCOPE` | `stream` | `stream`: the project id is a Loki stream label. `metadata`: it is structured metadata |
| `OBSERVABILITY_PROMETHEUS_URL` | `PROMETHEUS_URL` or `http://kube-prometheus-kube-prome-prometheus.monitoring.svc:9090` | Prometheus |
| `OBSERVABILITY_LOKI_URL` | `LOKI_URL` or `http://loki.monitoring.svc:3100` | Loki |
| `OBSERVABILITY_TEMPO_URL` | `TEMPO_URL` or `http://tempo.monitoring.svc:3200` | Tempo |
| `OBSERVABILITY_PYROSCOPE_URL` | `PYROSCOPE_URL` or `http://pyroscope.monitoring.svc:4040` | Pyroscope |

Values outside the allowed range are clamped to it. Profile queries are additionally limited to
just under 24 hours (see [Profiles](#profiles)).

### Rate limit

One per-user limit (default 600 requests per minute, `OBSERVABILITY_RATE_LIMIT`) covers every
observability endpoint except `status`, including the fleet view; with Redis it is shared by
all API replicas. Typical portal cost per tab load: Overview 2 (summary, RED), APM 3, Traces 1,
Logs 1 (+1 every 5 s while live tail is on), Infra 1, Profiles 2, **RUM 5** (one Loki query per
web vital). Over the limit the API answers 429 and the view shows the error; raise the variable
if many people share one agent token or account.

`GET /api/observability/status` reports whether the backends are installed and the current
`maxRangeHours`, `maxLogLines` and `maxTraces`.

## Troubleshooting

| Message | Status | What to do |
|---|---|---|
| `Observability backends are not installed (full install profile)` | 503 | Install the full profile; check `PLATFORM_OBSERVABILITY` on the API |
| `<Backend> backend is unavailable` | 502 | The API cannot reach Prometheus / Loki / Tempo / Pyroscope; check the pods in `monitoring` and the `OBSERVABILITY_*_URL` settings |
| `<Backend> backend is busy; retry shortly` | 503 | The backend returned 429 or 503; retry |
| `<Backend> query timed out; narrow the time range or the query` | 504 | Shorten the range or simplify the query; raise `OBSERVABILITY_QUERY_TIMEOUT_MS` if needed |
| `<Backend> response is too large; narrow the query` | 502 | Narrow the query, or raise `OBSERVABILITY_MAX_RESPONSE_BYTES` |
| `<Backend> backend rejected the query; check its syntax` | 400 | Fix the PromQL / LogQL / TraceQL |
| `<Backend> backend error` | 502 | Other backend failure; see the API log (`[observability] …`) |
| `invalid since (use e.g. 15m, 1h, 24h, 7d)`, `start must be before end`, `invalid step`, … | 400 | Fix the parameter |
| Any 400 with `code: "invalid_query"` | 400 | The query cannot be limited to the project; simplify it |
| `Too many observability queries. Retry in a minute.` | 429 | Rate limit (`OBSERVABILITY_RATE_LIMIT`) |
| `Trace not found` | 404 | The trace does not exist, or has no spans from this project |
| Overview shows numbers but a red banner | 200 | `telemetryError`: metrics were unavailable; database-backed counts are still shown |

Empty tables usually mean no data: no SDK telemetry from the services (APM, Traces, Logs,
Profiles), no frontend RUM (RUM), or no running environment (Infra).

## API

All endpoints need authentication. Project endpoints require project role **viewer** or
higher; all except `status` share the rate limit.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/observability/status` | Backends installed? Current limits |
| `GET` | `/api/observability/fleet?since=` | Health, request rate, error rate, p95, alerts, open errors, synthetics and SLOs per accessible project |
| `GET` | `/api/projects/<id>/observability/summary?since=&environment=` | RED + Apdex, alert incidents, open errors, synthetics status, SLOs, health |
| `GET` | `/api/projects/<id>/observability/services?since=&environment=` | Services with request rate, error rate, p95 |
| `GET` | `/api/projects/<id>/observability/endpoints?since=&service=&environment=` | Top 100 endpoints (span names) with rate, errors, p95 |
| `GET` | `/api/projects/<id>/observability/red?since=&service=&environment=&step=` | RED time series |
| `GET` | `/api/projects/<id>/observability/service-graph?since=&environment=` | Service map nodes and edges |
| `GET` | `/api/projects/<id>/observability/infra?since=&environment=&step=` | Pod CPU and memory series, restarts |
| `GET` | `/api/projects/<id>/observability/query/prom?query=&start=&end=&step=&instant=1` | Scoped PromQL (range, or instant with `instant=1`) |
| `GET` | `/api/projects/<id>/observability/query/loki?query=&limit=&direction=&after=` | Scoped LogQL; without `query`, built from `service`, `environment`, `level`, `search`, `traceId`. `after` = nanosecond cursor for live tail |
| `GET` | `/api/projects/<id>/observability/query/tempo?q=&limit=` | Scoped TraceQL search; without `q`, built from `service`, `name`, `environment`, `minDuration`, `maxDuration`, `status` (`error`/`ok`/`unset`) |
| `GET` | `/api/projects/<id>/observability/traces/<traceId>` | One trace, this project's spans only (`spans`, `hiddenSpans`, `truncated`) |
| `GET` | `/api/projects/<id>/observability/profiles/meta?since=` | Profiled services and profile types (default range 24 h, clamped under 1 day) |
| `GET` | `/api/projects/<id>/observability/query/pyroscope?profileType=&service=&environment=&since=&maxNodes=` | Flame graph (`maxNodes` default 1024, max 8192; range clamped under 1 day) |

```bash
curl -G "$API/api/projects/$PROJECT/observability/query/prom" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'query=sum by (service) (rate(traces_spanmetrics_calls_total[5m]))' \
  --data-urlencode 'since=6h'
```
