# Heatmaps (click and scroll depth)

Per-page click heatmaps and scroll-depth charts, captured by the React / Angular browser SDKs
and shown in the portal under **Project → 🔥 Heatmaps**. Data is stored only as anonymous
aggregates in Postgres (no raw events, no user or session ids, no IPs).

## Enable in the SDK

Heatmaps ride on frontend RUM ([Frontend RUM](frontend-rum.md)): when RUM runs (configured,
not Do-Not-Track, sampled in) and `heatmaps` is set, the SDK lazy-loads `rum-heatmap` (a
~2.7 KB gzip chunk). Apps without the option never download it.

```ts
// React: <PlatformProvider config={{ ..., rum: { telemetryUrl: '/rum-config.json', heatmaps: true } }}>
// Angular: providePlatformRum({ telemetryUrl: '/rum-config.json', heatmaps: true }, { appName: 'web' })
rum: {
  telemetry,                 // block from GET /api/sdk/config (adds heatmapsEndpoint)
  heatmaps: {
    samplingRatio: 0.5,      // per session, on top of RUM sampling (default 1)
    consent: () => cmp.analyticsAllowed(), // checked before start and before every send
    subjectId: () => currentUser?.id,       // optional: lets the API apply recorded #47 consent
    // endpoint / token default to telemetry.heatmapsEndpoint and telemetry.heatmapsToken || browserToken
  },
}
```

Tokens: the ingest accepts a **browser-kind SDK token** (`POST /api/projects/:id/tokens`
with `{ "name": "web", "kind": "browser" }`, long-lived, write-only) or the short-lived RUM web
ingest token (`telemetry.browserToken`, origin-bound). Either way the project is taken from the
credential, never from the request body.

## What is captured

| Event | Fields |
|-------|--------|
| click | page (normalised like RUM view names: `/orders/42` → `/orders/:id`), viewport bucket (`mobile` < 768 px ≤ `tablet` < 1024 px ≤ `desktop`), x / y as fractions of the document width / height, a short CSS selector (tag, id, classes, `data-rum-name`; never text or values) |
| scroll | page, viewport bucket, maximum scroll depth (percent of the document) reached in one page view — sent once, when the view ends (SPA route change, tab hidden, page unload) |

Batching: events are sent every 5 s or every 100 events (`keepalive` on page hide). Failures
(network, 429, 5xx) keep the events and back off exponentially (Retry-After honoured); 400/413
drop the batch; 401/403 or a `consent: false` reply stop capture for the page load.

Privacy gates: Do-Not-Track / Global Privacy Control always disable capture in the SDK, and the
API also discards batches carrying `DNT: 1` / `Sec-GPC: 1`. The API resolves #47 consent for
each batch (recorded consent for `subjectId`, else the project's analytics default) and discards
the batch when analytics is not allowed. `subjectId` is used only for that lookup.

## Storage and GDPR

`POST /api/sdk/heatmap/events` folds each batch into counts and upserts
(`count = count + n`) into:

| Table | Key | Value |
|-------|-----|-------|
| `heatmap_click_cells` | project, page, viewport, UTC day, cell x/y (100 × 100 grid) | clicks |
| `heatmap_click_targets` | project, page, viewport, day, selector | clicks |
| `heatmap_scroll_depth` | project, page, viewport, day, depth bucket (5 %) | page views |
| `heatmap_pages` | project, page | first / last day (caps distinct pages per project) |

The rows contain no personal data and cannot be linked to a person, so a GDPR subject delete
(`POST /api/projects/:id/privacy/gdpr-delete`) has nothing to remove here; deleting a project
cascades. Retention uses the #47 per-type setting `heatmaps` (default 90 days, Project →
Privacy → Retention); the leader runs `heatmaps-retention` hourly.

Limits (env on the API): `HEATMAP_IP_RATE_LIMIT` (300 requests/min per IP),
`HEATMAP_PROJECT_RATE_LIMIT` (3000 requests/min per project), `HEATMAP_MAX_PAGES` (1000
distinct pages per project; events for further new pages are dropped). Batches are limited
to 64 KiB, 500 events and 20 distinct pages.

## Query API (project members)

- `GET /api/projects/:projectId/heatmaps/pages?from=&to=&viewport=` → `{ pages: [{ page, clicks, views }] }`
- `GET /api/projects/:projectId/heatmaps?page=&from=&to=&viewport=all|mobile|tablet|desktop&type=click`
  → `{ grid: { cols, rows }, total, maxCell, cells: [[x, y, count]], topTargets }`
- `...&type=scroll` → `{ views, buckets: [{ depth, count }], reach: [{ depth, pct }] }`

Dates are UTC days (`YYYY-MM-DD`), default the last 7 days, at most 366 days.

## Portal

The Heatmaps page lists pages with counts, filters by viewport and range, draws the click
heatmap on a canvas and the scroll-depth reach chart. The background is the page's first DOM
snapshot from session replay (`GET /api/projects/:id/replays/:sessionId/snapshot?page=`; the
session is picked from the replay list or typed in the toolbar), rendered read-only: sanitised
with DOMPurify, in an `<iframe sandbox="allow-same-origin">` (no scripts) with a CSP that blocks
scripts and connections. Without session replay the heatmap is drawn over a neutral grid.
