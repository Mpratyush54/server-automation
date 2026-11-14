# Monitor real users in the browser

See how fast your web app is for real visitors, which errors they hit, and what they did before a problem. Results appear in the project's **Monitoring** section, **Users** view: web vitals, session replays and heatmaps.

This works with the React and Angular SDKs (`@mpratyush54/sdk-react`, `@mpratyush54/sdk-angular`). It needs the `full` install profile. It is off until you turn it on in your app.

## What you get

| Data | Details |
|---|---|
| Web vitals | Page speed measures: LCP (largest paint), INP (input delay), CLS (layout shift), TTFB (time to first byte) and FCP (first paint), per page |
| Errors | Uncaught errors and unhandled promise rejections, with stack frames. Also errors caught by React `ErrorBoundary` or Angular `PlatformErrorHandler`. |
| Page loads and requests | Timing for the page and for every resource (fetch and XHR calls, scripts, images) |
| Clicks | A CSS selector and tag for each click. No element text by default. |
| Views | One view per route change, with the URL turned into a pattern such as `/orders/:id` |
| Traces | A browser span for each call to your backend, joined to the backend's trace |

## Turn it on

1. Install with the full profile: `sudo platformctl provision --profile full`.
2. Tell the platform which sites your app runs on. The project's environment hosts and project domain count automatically. For any other origin, add a value named `TELEMETRY_ALLOWED_ORIGINS` in the project's **Configuration** section, for example `https://shop.example.com, https://*.preview.example.com, http://localhost:4200`. With no allowed origin, browser monitoring stays off.
3. Give your frontend the telemetry settings. Your backend reads them from the platform with its SDK token (see [For developers / API](#for-developers--api)) and serves them to the browser, for example as `/rum-config.json`. Never put the SDK token itself in the browser.
4. Add the `rum` option to the SDK, as in the examples below.
5. Deploy, open your app, then open **Monitoring > Users** in the project.

### React

```tsx
import { PlatformProvider, useRumPageView } from '@mpratyush54/sdk-react';
import { BrowserRouter, useLocation } from 'react-router-dom';

const config = {
  apiBase: 'https://platform.example.com',
  token: '', // RUM does not need the SDK token
  projectId: 'my-project',
  appName: 'shop-web',
  rum: {
    telemetryUrl: '/rum-config.json',          // or: telemetry: { ...the block... }
    propagateTo: ['https://api.example.com'],  // send trace headers only here
  },
};

function RumRoutes() {
  useRumPageView(useLocation()); // /orders/42 -> view "/orders/:id"
  return null;
}

<PlatformProvider config={config}>
  <BrowserRouter>
    <RumRoutes />
    {/* routes */}
  </BrowserRouter>
</PlatformProvider>;
```

Without the provider, call `initRum(options, { appName })` and `setRumView(name)`.

### Angular

```ts
// NgModule / importProvidersFrom
PlatformModule.forRoot({ apiBase, token, projectId, appName: 'shop-web',
  rum: { telemetryUrl: '/rum-config.json', propagateTo: ['https://api.example.com'] } });

// or standalone, RUM only
bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideHttpClient(),
    providePlatformRum({ telemetryUrl: '/rum-config.json' }, { appName: 'shop-web' })],
});

// Track router views (once, for example in AppComponent)
constructor(router: Router, rum: PlatformRumService) { rum.trackRouter(router); }
```

Startup is never delayed. Angular catches errors inside its zone, so they reach monitoring through `PlatformErrorHandler` (with `forRoot`) or `PlatformRumErrorHandler` (added by `providePlatformRum` unless you pass `{ errorHandler: false }`). A custom error handler can call `reportRumError(err)`. The Angular SDK is compiled for JIT, so import `@angular/compiler` in `main.ts`.

## When nothing is collected

The SDK loads nothing, not even its monitoring code, when:

- the `rum` option is not set,
- the platform reports monitoring as disabled (no full profile),
- the browser sends Do Not Track or Global Privacy Control,
- the session is sampled out.

## Record sessions (session replay)

A session replay is a recording of what a visitor saw and did, so you can watch the steps that led to an error. It is off unless you add `replay`, and by default it records only after the visitor agrees.

```ts
rum: {
  telemetryUrl: '/rum-config.json',
  replay: { sampleRate: 0.1, onErrorSampleRate: 1 }, // the defaults
}
// when the visitor agrees, for example in your consent banner:
import { setConsent } from '@mpratyush54/sdk-react'; // or sdk-angular
setConsent({ replay: true });   // setConsent({ replay: false }) stops recording at once
```

- **Consent.** Nothing is recorded until `setConsent({ replay: true })` is called, or consent was recorded for the visitor on the server (see [Privacy and data retention](../operations/telemetry-privacy.md)). A "no" always wins. Do Not Track and Global Privacy Control turn replay off.
- **Masking.** All form field values are masked. Visible text has e-mails, tokens and credentials removed. Add the class `platform-mask` (or attribute `data-platform-mask`) to mask an element. Add `platform-block` (or `data-platform-block`) to leave it out entirely; it shows as a grey box. Canvas, fonts, images, cross-origin frames and scripts are never captured. URLs lose their query values.
- **Sampling.** `sampleRate` is the share of sessions recorded in full. Of the rest, `onErrorSampleRate` keep the last 60 seconds in memory and upload them only when an error happens, then keep recording.
- **Watching.** Replays are listed under **Monitoring > Users**, **Session replays**. Filter by page, errors, duration or environment. The player shows errors, page changes and network calls on the timeline, with links to the error and the trace. An error links to its replay.
- **Who can watch.** Project members only. Every view is written to the audit log.
- **Retention.** Replays are kept 7 days by default. Change it under the project's **Settings > Privacy**.

| Replay option | Default | Meaning |
|---|---|---|
| `sampleRate` | 0.1 | Share of sessions recorded in full |
| `onErrorSampleRate` | 1 | Share of the rest that buffer and upload on error |
| `bufferSeconds` | 60 | On-error buffer length (10–300) |
| `requireConsent` | `true` | Record only after consent |
| `maskAllInputs` | `true` | Mask every form field value (passwords always) |
| `maskText` | `pii` | `pii` removes personal data from text, `all` stars every character, `none` keeps text |
| `blockClass`, `blockSelector`, `maskTextClass`, `maskTextSelector` | `platform-block`, `[data-platform-block]`, `platform-mask`, `[data-platform-mask]` | Extra classes and selectors |
| `captureNetwork` | `true` | Show network calls on the timeline |
| `snapshotOnNavigation` | `true` | Take a page snapshot after route changes |
| `endpoint`, `userId`, `flushIntervalMs`, `maxChunkBytes` | — / — / 5000 / 65536 | Upload target, user id, upload interval, chunk size |

The demo apps in `examples/sdk-apps/react-web` and `examples/sdk-apps/angular-web` show replay with a consent banner. See [examples/sdk-apps/README.md](../../examples/sdk-apps/README.md#session-replay-40).

## Options

| Option | Default | Meaning |
|---|---|---|
| `telemetry` | — | The telemetry settings block. Missing, `null` or `enabled: false` turns monitoring off. |
| `telemetryUrl` | — | URL that returns the block (or `{ telemetry }`). Used when `telemetry` is not given. Fetched without credentials. |
| `propagateTo` | page origin | Origins, URL prefixes or RegExps that receive the `traceparent` header. `[]` turns it off. No other URL gets the header. |
| `samplingRatio` | from the block, or 1 | Share of sessions monitored, 0–1. Decided once per tab. |
| `respectDoNotTrack` | `true` | Stay off when Do Not Track or Global Privacy Control is set |
| `captureActionText` | `false` | Add redacted, shortened element text to clicks (never for form fields or masked elements) |
| `captureQueryValues` | `false` | Keep URL query values (otherwise `?q=[REDACTED]`) |
| `trackResources` | `true` | Report all resources, not only fetch and XHR |
| `appName`, `appVersion`, `environment` | from the provider config | App details attached to the data |
| `beforeSend` | — | Your own filter, run after the built-in redaction. Return `null` to drop an item. |
| `heatmaps` | off | `true` or options. See [Heatmaps](heatmaps.md). |
| `replay` | off | Session replay options (above) |

## Privacy defaults

No personal data is sent by default. Before anything leaves the browser, the SDK removes authorization values, SDK tokens, JWTs, cookies, password-like fields, e-mail addresses, user info in URLs and URL query values. User e-mail, username and full name are removed from user details. Clicks carry only a selector and tag. Password, card and one-time-code fields, and elements marked `data-platform-mask`, never carry text. View names are turned into patterns (`/users/42` becomes `/users/:id`, e-mail segments become `:email`). Geolocation is not collected.

## How it works

- The SDK uses Grafana Faro in a separate, lazily loaded chunk (`import('./rum-faro')`). Apps that never use RUM contain no Faro code. Apps that use the provider or module without `rum` get the chunk built but never download it.
- Data goes to the platform collector at `https://otel.<DOMAIN>/collect` (Grafana Alloy, full profile). Browser spans carry a W3C `traceparent` header, so the backend span from sdk-node or sdk-python joins the same trace in Tempo.
- Web vitals use the `web-vitals` measurements, tagged with the view id. Faro's web-vitals attribution and geolocation are not collected.
- Redaction: every item passes through `scrubTransportItem` (the SDK's `redactSensitive` plus e-mail, URL user info and query value removal). Masked click targets match `SENSITIVE_INPUT_SELECTOR`, the same selector `maskSensitiveInputs` uses.
- The browser token in the telemetry block is public by design. It is short-lived, scoped to one project and environment, rate limited, and accepted only from the project's allowed origins.
- Transport: the SDK has its own small Faro transport. It sends `Authorization: Bearer <browser token>`, batches items, uses `keepalive` on page hide, honours `Retry-After` on 429 and 503, backs off with jitter on network errors and 5xx, and keeps a bounded queue of 30 batches (overflow is dropped and counted). Other 4xx errors are not retried. It never throws into your app.
- Allowed origins: the API keeps the collector's CORS list up to date from every project's environment hosts, project domain and `TELEMETRY_ALLOWED_ORIGINS`. Hosts ending in `example.com` are ignored. After a change, allow up to about two minutes before the collector accepts a new origin. The browser token picks it up at its next settings refresh. Details: [Full monitoring](../operations/telemetry.md).
- The collector allows the `Authorization` and `Content-Type` request headers and exposes `Retry-After`. When a browser token exceeds its budget, it answers 429 with `Retry-After` and CORS headers.
- Your backend must allow the `traceparent` header in `Access-Control-Allow-Headers` for cross-origin calls (the `cors` npm package reflects requested headers by default).

### Bundle size

Measured with `npm run size` in each SDK (esbuild, minified, gzip -9):

| | sdk-react | sdk-angular |
|---|---|---|
| Initial chunk added by RUM | +0.9 KB | +0.9 KB |
| Lazy Faro chunk (only when enabled and sampled) | 18.5 KB | 18.5 KB |
| Total when enabled (budget under 30 KB) | 19.4 KB | 19.4 KB |
| Lazy replay controller (only when `replay` is set; budget under 8 KB) | 5.5 KB | 5.5 KB |
| Lazy rrweb recorder and gzip (only after sampling and consent; budget under 40 KB) | 26.5 KB | 26.5 KB |

In the demo apps the lazy chunk is 21.9 KB (Vite, ES2020 target) and 19.2 KB (Angular CLI). The size check fails if Faro reaches the initial chunks.

### Session replay internals

- Recording uses rrweb. Sessions are sticky per tab: 30 minutes idle or 4 hours at most.
- Upload: chunks of 64 KiB raw JSON or 5 seconds, gzipped (fflate), sent to `POST <replayEndpoint>/chunks` with the browser token (`telemetry.replayEndpoint`, present with the full profile), or to `apiBase` with the SDK token. Retries back off and honour `Retry-After`. The queue is bounded at 4 MiB.
- Unload delivery: on `pagehide` or `visibilitychange` to hidden, the open chunk is cut into pieces of at most 40 KiB raw JSON and every queued chunk is sent at once, including one whose normal upload is still in flight. The server answers a re-sent chunk with 200 and stores it once. This keeps the last page of a session, and sessions shorter than 5 seconds.
  - Unload uploads carry the token in the body, not a header: `Content-Type: text/plain`, body `{"v":1,"token":"<browser token>","chunk":"<base64 of the gzip chunk>"}`. That makes them CORS simple requests with no preflight that the unload could cancel. The token is never put in the URL. The API accepts this form only on `POST /api/sdk/replay/chunks` and checks it like the header form: same token kinds, same `Origin` check for `plat_ingest_web_` tokens, same size limit (on the decoded gzip bytes), validation, deduplication and rate limit. A request with both a body token and an `Authorization` header is refused (400).
  - Transport: `navigator.sendBeacon` first; if it is missing, throws or returns `false`, then `fetch(..., { keepalive: true })` with the same body; if that fails, the chunk is queued again.
  - Limits: browsers allow at most 64 KiB of beacon or keepalive bodies in flight per page. 40 KiB pieces keep one body under that even for data that does not compress. Chunks that do not fit get a best-effort normal request. Uploads while the page is visible use `application/octet-stream` with `Authorization: Bearer`.
- Ordering: the API works out a chunk's pages from its snapshot URLs and navigation markers in time order, so a session's first page is where recording started, even if the only chunk is the final one. Chunks of one session are stored under a per-session lock, so parallel uploads cannot drop pages or exceed limits.
- Markers: errors, route changes and network calls (method, redacted URL, status, duration, trace id) are recorded as rrweb custom events. RUM error events carry `replayId`.
- Storage: object storage bucket `replays` (MinIO), keys `replays/<projectId>/<sessionId>/<seq>.json.gz`, plus `replay_sessions` and `replay_chunks` rows in Postgres. An hourly job deletes sessions older than the project's replay retention. A bucket lifecycle rule is the backstop. GDPR delete removes a subject's replays by user id, consent subject or session id.
- Audit actions: `replay.view`, `replay.chunk_view` (per downloaded chunk), `replay.snapshot_view`, `replay.delete`. AI agent tokens (MCP) also need the `replays:read` scope, which is not in the default agent scopes; their audit entries carry the agent token id and name.
- Server switch: on by default with the full profile (`PLATFORM_OBSERVABILITY`). `REPLAY_INGEST=off|on` overrides it. Limits: `REPLAY_MAX_CHUNK_BYTES` (2 MiB compressed), `REPLAY_MAX_RAW_BYTES` (16 MiB decompressed), `REPLAY_MAX_CHUNKS_PER_SESSION` (3000), `REPLAY_MAX_SESSION_BYTES` (100 MiB), `REPLAY_RATE_LIMIT` (600 per minute per IP).
- Heatmap backgrounds come from replay snapshots: `GET /api/projects/:projectId/replays/:sessionId|latest/snapshot?page=/orders/:id` returns the first full page snapshot as inert HTML (no scripts, a CSP added) for a sandboxed iframe. With `latest` it is the newest snapshot of that page from any session. A page left within 300 ms of opening gets no snapshot.
- Demo apps: set `RUM_REPLAY_ENDPOINT` (Kubernetes Secret `sdk-demo-rum`, key `replayEndpoint`). Each has a Playwright check, `e2e/replay.mjs` (Angular: `ANGULAR_URL`, `BROWSER=chromium|firefox|webkit`).

## For developers / API

The telemetry block comes from `GET /api/sdk/config`. That endpoint takes the server SDK token and also returns project configuration, so call it from your backend or deploy step, never from the browser.

Pass these fields of the `telemetry` block to the browser: `enabled`, `faroEndpoint`, `browserToken`, `samplingRatio`, `resource` and `errorsEndpoint`, and, for replay and heatmaps, `replayEndpoint` and `heatmapsEndpoint`. Do not pass `ingestToken`: it is the server token.

When the observability backend is not installed, `enabled` is `false` and every endpoint and token is `null`. `browserToken` is also `null` when the project has no allowed browser origin.
