# See where visitors click and scroll

Heatmaps show where visitors click on each page and how far down they scroll. Open them in the project's **Monitoring** section, **Users** view, under **Heatmaps**.

Heatmaps are collected by the React and Angular SDKs. They store only anonymous counts: no user, session or IP address.

## Turn on heatmaps

First set up [browser monitoring](frontend-rum.md). Then add `heatmaps: true` to the `rum` option:

```ts
// React
<PlatformProvider config={{ ...config, rum: { telemetryUrl: '/rum-config.json', heatmaps: true } }}>

// Angular
providePlatformRum({ telemetryUrl: '/rum-config.json', heatmaps: true }, { appName: 'web' })
```

To ask for consent or sample fewer sessions, pass options instead of `true`:

```ts
rum: {
  telemetryUrl: '/rum-config.json',
  heatmaps: {
    samplingRatio: 0.5,                     // share of sessions, on top of RUM sampling (default 1)
    consent: () => cmp.analyticsAllowed(),  // checked before start and before every send
    subjectId: () => currentUser?.id,       // optional: lets the platform apply consent recorded for this person
  },
}
```

Deploy, click around your app, and open **Monitoring > Users**. Counts can take a few seconds to appear.

## Read a heatmap

1. Pick a date range and a viewport: all, mobile (under 768 px wide), tablet (768–1023 px) or desktop (1024 px and wider).
2. Pick a page in **Pages**. Each page is a path or route pattern, such as `/orders/:id`.
3. The click heatmap is drawn over the page. **Most clicked elements** lists the top click targets. **Scroll depth** shows how many visitors reached each part of the page.

The page picture behind the heatmap comes from [session replay](frontend-rum.md#record-sessions-session-replay). By default it is the newest recording of that page. To use a specific recording, type its id in the **Replay session** field. A page has a picture once at least one visitor who allowed session replay has opened it. Until then the heatmap is drawn over a plain grid, and the page says why.

Click positions are relative to the whole page at the visitor's width. So the overlay is approximate when the recorded page looks different from the visitor's layout, for example when several apps with different layouts report into one project.

## What is collected

| Event | Fields |
|---|---|
| Click | Page pattern, viewport group, position as a fraction of page width and height, and a short CSS selector (tag, id, classes, `data-rum-name`). Never text or field values. |
| Scroll | Page pattern, viewport group, and the deepest point reached in one page view (percent of the page). Sent once, when the view ends. |

## Privacy

- Do Not Track and Global Privacy Control always turn heatmaps off.
- The platform checks consent for every batch: consent recorded for the `subjectId`, otherwise the project's analytics default. Set the default under the project's **Settings > Privacy**. The `subjectId` is used only for that check.
- Counts cannot be linked to a person, so a personal data delete has nothing to remove here.
- Heatmap data is kept 90 days by default. Change it under **Settings > Privacy > Retention**.

See [Privacy and data retention](../operations/telemetry-privacy.md).

## How it works

- The SDK lazy-loads a small `rum-heatmap` chunk (about 2.7 KB gzip) only when RUM runs (configured, no Do Not Track, sampled in) and `heatmaps` is set.
- Tokens: the ingest accepts a long-lived, write-only **browser** SDK token (create one under the project's **Settings > SDK tokens**, kind *Browser*), or the short-lived RUM browser token (`telemetry.browserToken`, tied to allowed origins). The SDK uses `telemetry.heatmapsEndpoint` and `telemetry.heatmapsToken`, falling back to `browserToken`. You can also set `endpoint` and `token` in the heatmap options. The project always comes from the token, never from the request body.
- Batching: events are sent every 5 seconds or every 100 events, with `keepalive` on page hide. Network errors, 429 and 5xx keep the events and back off (honouring `Retry-After`). 400 and 413 drop the batch. 401, 403 or a `consent: false` reply stop capture for that page load.
- The API also discards batches that carry `DNT: 1` or `Sec-GPC: 1`.
- Storage: each batch is folded into counts in Postgres, added with `count = count + n`:

  | Table | Key | Value |
  |---|---|---|
  | `heatmap_click_cells` | project, page, viewport, UTC day, cell x/y (100 × 100 grid) | clicks |
  | `heatmap_click_targets` | project, page, viewport, day, selector | clicks |
  | `heatmap_scroll_depth` | project, page, viewport, day, depth bucket (5%) | page views |
  | `heatmap_pages` | project, page | first and last day (caps distinct pages per project) |

- Deleting a project removes its heatmap data. Retention uses the per-project `heatmaps` setting; the leader runs the `heatmaps-retention` job hourly.
- Limits (API environment variables): `HEATMAP_IP_RATE_LIMIT` (6000 requests per minute per IP, high on purpose because many visitors can share one address; the ingress also caps one IP at 100 requests per second), `HEATMAP_PROJECT_RATE_LIMIT` (30000 requests per minute per project), `HEATMAP_MAX_PAGES` (1000 distinct pages per project; events for more new pages are dropped). Batches are limited to 64 KiB, 500 events and 20 distinct pages.
- Buffered writes: the per-project page cap is checked synchronously, so the `accepted` count in the response is exact. The count increments are then gathered in memory and written every `HEATMAP_FLUSH_MS` (default 2000 ms), or as soon as `HEATMAP_BUFFER_MAX_KEYS` (default 20000) keys are pending, in one transaction. Additive upserts keep any number of replicas correct. The buffer is flushed on graceful shutdown (SIGTERM). If a process is killed hard, up to one flush interval of its counts is lost. Queries can lag by up to one flush interval. A failed flush keeps the counts for the next try.
- Page backgrounds: `GET /api/projects/:id/replays/latest/snapshot?page=` (or a specific session id instead of `latest`). The snapshot is sanitised with DOMPurify and shown in an `<iframe sandbox="allow-same-origin">` with a CSP that blocks scripts and connections. Masked fields stay masked.

## For developers / API

Ingest: `POST /api/sdk/heatmap/events` with a browser SDK token or the RUM browser token. Create a browser SDK token with `POST /api/projects/:id/tokens` and `{ "name": "web", "kind": "browser" }`.

Query (project members). Dates are UTC days (`YYYY-MM-DD`); the default is the last 7 days, at most 366 days.

- `GET /api/projects/:projectId/heatmaps/pages?from=&to=&viewport=` returns `{ pages: [{ page, clicks, views }] }`.
- `GET /api/projects/:projectId/heatmaps?page=&from=&to=&viewport=all|mobile|tablet|desktop&type=click` returns `{ grid: { cols, rows }, total, maxCell, cells: [[x, y, count]], topTargets }`.
- `...&type=scroll` returns `{ views, buckets: [{ depth, count }], reach: [{ depth, pct }] }`.
