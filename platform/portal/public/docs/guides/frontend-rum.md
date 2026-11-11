# Frontend RUM (React and Angular SDKs)

`@mpratyush54/sdk-react` and `@mpratyush54/sdk-angular` can collect real user monitoring
(RUM) data with [Grafana Faro](https://grafana.com/oss/faro/) and send it to the platform
collector (`https://otel.<DOMAIN>/collect`, Grafana Alloy, full install profile):

| Signal | Details |
|--------|---------|
| Web vitals | LCP, INP, CLS, TTFB, FCP (`web-vitals` measurements, tagged with the view id) |
| Errors | Uncaught errors and unhandled rejections with stack frames, plus errors caught by React `ErrorBoundary` / Angular `PlatformErrorHandler` |
| Resource timings | Navigation and every resource (fetch/XHR, scripts, images...) |
| User actions | `click` events with a CSS selector and tag; **no element text by default** |
| Views | One view per route change (react-router v6/v7, Angular Router), with a fresh view id |
| Session | Session id per browser tab; sampling decided once per session |
| Traces | A client span per fetch/XHR/HttpClient call to allowed origins, with a W3C `traceparent` header so the backend span (sdk-node / sdk-python) joins the same trace in Tempo |

RUM is **off unless you set one option**, `rum`. When it is not set, or the platform reports
`telemetry.enabled: false`, or the browser sends Do-Not-Track, or the session is sampled out,
the SDK loads nothing: Faro lives in a separate lazy chunk (`import('./rum-faro')`) that is
never fetched.

## Configure

The browser needs the `telemetry` block of `GET /api/sdk/config` (only `enabled`,
`faroEndpoint`, `browserToken`, `samplingRatio`, `resource`). That endpoint takes the SDK token
and also returns project config, so **do not call it from the browser**: have your backend (or
your deploy step) hand the block to the frontend, either inline (`telemetry`) or as a small
JSON file / endpoint (`telemetryUrl`, fetched without credentials). The browser token is
public by design: it is scoped to one project/environment, rate limited and only accepted
from the project's allowed origins.

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
    telemetryUrl: '/rum-config.json', // or: telemetry: { enabled, faroEndpoint, browserToken, ... }
    propagateTo: ['https://api.example.com'], // traceparent only to these origins
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

Without the provider: `initRum(options, { appName })` and `setRumView(name)`.

### Angular

```ts
// NgModule / importProvidersFrom
PlatformModule.forRoot({ apiBase, token, projectId, appName: 'shop-web', rum: { telemetryUrl: '/rum-config.json', propagateTo: ['https://api.example.com'] } });

// or standalone, RUM only
bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes), provideHttpClient(), providePlatformRum({ telemetryUrl: '/rum-config.json' }, { appName: 'shop-web' })],
});

// Router views (once, e.g. in AppComponent)
constructor(router: Router, rum: PlatformRumService) { rum.trackRouter(router); }
```

The initializer never delays bootstrap. Angular catches errors inside its zone, so they reach
RUM through `PlatformErrorHandler` (`forRoot`) or `PlatformRumErrorHandler` (installed by
`providePlatformRum` unless `{ errorHandler: false }`; a custom handler can call
`reportRumError(err)`). sdk-angular is compiled for JIT, so apps import
`@angular/compiler` in `main.ts` (see the demo app).

## Options (`PlatformRumOptions`)

| Option | Default | Meaning |
|--------|---------|---------|
| `telemetry` | — | The telemetry block. `null` / `enabled: false` / missing endpoint or token = off |
| `telemetryUrl` | — | URL returning the block (or `{ telemetry }`), used when `telemetry` is not given |
| `propagateTo` | page origin | Origins, URL prefixes (`https://gw.example.com/v1`) or RegExps that get `traceparent`. `[]` disables propagation. Nothing else ever gets the header |
| `samplingRatio` | `telemetry.samplingRatio` or 1 | Session sampling 0..1 (sticky per tab) |
| `respectDoNotTrack` | `true` | Off when `navigator.doNotTrack`/`globalPrivacyControl` is set |
| `captureActionText` | `false` | Add redacted, truncated element text to clicks (never for inputs or masked fields) |
| `captureQueryValues` | `false` | Keep URL query values (otherwise `?q=[REDACTED]`) |
| `trackResources` | `true` | Report all resources, not only fetch/XHR |
| `appName`, `appVersion`, `environment` | provider config | Faro app meta |
| `beforeSend` | — | Extra filter run after the built-in redaction; return `null` to drop |
| `heatmaps` | off | `true` or options: click / scroll-depth heatmaps, lazy-loaded (+~2.7 KB gzip chunk). See [Heatmaps](heatmaps.md) |

## Privacy defaults (no PII)

Every item passes through `scrubTransportItem` before it leaves the browser: the SDK's
`redactSensitive` (Authorization/Bearer values, SDK tokens, JWTs, cookies, password-like
fields) plus e-mail addresses, URL userinfo and query values. User e-mail/username/full name
are stripped from Faro's user meta. Click events carry only a selector and tag; elements
matched by `SENSITIVE_INPUT_SELECTOR` (the same selector `maskSensitiveInputs` uses: password,
credit-card and one-time-code fields, `data-platform-mask`) are flagged `masked` and never
carry text. View names are normalized (`/users/42` -> `/users/:id`, e-mail segments ->
`:email`). Faro's web-vitals attribution sources and geolocation are not collected.

## Bundle size

Measured with `npm run size` in each SDK (esbuild, minified, gzip -9):

| | sdk-react | sdk-angular |
|---|---|---|
| Initial chunk added by RUM | +0.9 KB | +0.9 KB |
| Lazy Faro chunk (only when enabled + sampled) | 18.5 KB | 18.5 KB |
| Total when enabled (budget < 30 KB) | 19.4 KB | 19.4 KB |
| Lazy replay controller (only when `rum.replay` is set; budget < 8 KB) | 5.5 KB | 5.5 KB |
| Lazy rrweb recorder + gzip (only after sampling + consent; budget < 40 KB) | 26.5 KB | 26.5 KB |

In the demo apps the lazy chunk is 21.9 KB (Vite, ES2020 target) and 19.2 KB (Angular CLI).
Apps that never use RUM (no provider/module/`initRum`) contain no Faro code at all; apps that
use the provider/module without `rum` get the lazy chunk emitted but never download it.
The size check fails if Faro reaches the initial chunks.

## Session replay (#40)

Opt-in, privacy-first replay recorded with rrweb. Add `replay` to the `rum` options:

```ts
rum: {
  telemetryUrl: '/rum-config.json',
  replay: { sampleRate: 0.1, onErrorSampleRate: 1 }, // defaults
}
// when the visitor agrees (consent banner):
import { setConsent } from '@mpratyush54/sdk-react'; // or sdk-angular
setConsent({ replay: true });   // false stops a running recording at once
```

- **Consent.** `requireConsent` defaults to `true`: nothing is recorded, and rrweb is not even
  downloaded, until `setConsent({ replay: true })` is called on the device or consent is
  recorded server-side for the subject (`PUT /api/sdk/privacy/consent`, #47). An explicit
  `setConsent({ replay: false })` always wins, and the API refuses further chunks of a subject
  whose recorded consent is withdrawn. doNotTrack / Global Privacy Control disable replay.
- **Masking.** All input, textarea and select values are masked (`maskAllInputs`, passwords
  always). Visible text goes through the RUM redaction (`maskText: 'pii'`: e-mails, tokens,
  credentials); `maskText: 'all'` stars every character. Elements with class `platform-mask` /
  `rr-mask` or `[data-platform-mask]` (and the `SENSITIVE_INPUT_SELECTOR` fields) are fully
  masked; `platform-block` / `rr-block` / `[data-platform-block]` are not recorded at all
  (a grey box of the same size). Canvas, fonts, images, cross-origin iframes and scripts are
  never captured; URLs lose query values.
- **Sampling.** Per session (sticky per tab, 30 min idle / 4 h max): `sampleRate` records the
  whole session; otherwise `onErrorSampleRate` keeps only the last `bufferSeconds` (60) in
  memory and uploads them when an error happens, then keeps recording.
- **Upload.** Chunks of 64 KiB raw JSON or 5 s, gzip (fflate), `POST <replayEndpoint>/chunks`
  with the telemetry block's browser token (`telemetry.replayEndpoint`, present when the platform
  runs the full profile) or `PlatformConfig.apiBase` + SDK token. Retries with backoff and
  `Retry-After`, bounded 4 MiB queue, `keepalive` on page hide.
- **Unload delivery.** On `pagehide` or `visibilitychange` -> `hidden` (whichever fires first)
  the open chunk is cut into pieces of at most 48 KiB raw JSON and every queued chunk is sent
  with `fetch(..., { keepalive: true })` - including one whose normal upload is still in
  flight, because an unload may cancel it. No normal fetch is started for the final chunk, so
  the last page of a session, and sessions shorter than the 5 s flush interval, survive tab
  close and navigation away. The server answers a re-sent chunk with 200 and stores it once.
  Limits: browsers allow at most 64 KiB of keepalive bodies in flight per page; chunks that do
  not fit stay queued and get a best-effort normal request (delivered when the page was only
  hidden, possibly lost on a real unload; the queue is per page, not persisted).
  `navigator.sendBeacon` is not used: it cannot send the `Authorization` header the replay API
  requires. A keepalive request carrying that header needs a CORS preflight; if a browser
  refuses such a request, the chunk is requeued for the normal path.
- **Ordering.** The API derives a chunk's pages from its Meta hrefs and navigation markers in
  timestamp order (then the SDK's page list, then the page when the chunk was cut), so the
  session's `first_page` is where recording started even when the only chunk is the final one.
  Chunks of one session are stored under a per-session lock (duplicate check, limits, page
  merge and counters are atomic), so parallel uploads cannot drop pages or exceed the limits.
- **Markers.** Errors (uncaught, and framework-caught via `reportRumError`), SPA navigations and
  network calls (method, redacted URL, status, duration, trace id from RUM client spans) are
  recorded as rrweb custom events. RUM error events carry `replayId`, so an error issue links
  to its replay.
- **Portal.** Project -> Replays lists sessions (filters: page, errors, duration, environment);
  the player (rrweb-player, lazy-loaded) shows the markers on the timeline with links to the
  error issue and the Tempo trace. Project members only; every access is audited
  (`replay.view`, `replay.chunk_view` per downloaded chunk, `replay.snapshot_view`,
  `replay.delete`). Agent tokens (MCP) additionally need the `replays:read` scope, which is not
  in the default agent scopes; their audit entries carry the agent token id and name.
- **Storage and retention.** MinIO bucket `replays`, `replays/<projectId>/<sessionId>/<seq>.json.gz`,
  plus `replay_sessions` / `replay_chunks` rows. An hourly job deletes sessions older than the
  project's replay retention (privacy settings, default 7 days); the bucket lifecycle rule is the
  backstop. GDPR delete removes a subject's replays by user id, consent subject or session id.
- **API switch.** On by default with the full profile (`PLATFORM_OBSERVABILITY`);
  `REPLAY_INGEST=off|on` overrides. Limits: `REPLAY_MAX_CHUNK_BYTES` (2 MiB compressed),
  `REPLAY_MAX_RAW_BYTES` (16 MiB decompressed), `REPLAY_MAX_CHUNKS_PER_SESSION` (3000),
  `REPLAY_MAX_SESSION_BYTES` (100 MiB), `REPLAY_RATE_LIMIT` (600/min per IP).
- **Heatmap backgrounds.** `GET /api/projects/:projectId/replays/:sessionId|latest/snapshot?page=/orders/:id`
  returns the first full DOM snapshot of that page as inert HTML (no scripts, CSP prepended) for a
  sandboxed iframe, plus the rrweb events. With `latest` it is the newest snapshot of that page
  (path or route name) from any session. A page that was left within 300 ms of navigating to it
  (before it rendered) gets no snapshot.

| Replay option | Default | Meaning |
|---------------|---------|---------|
| `sampleRate` | 0.1 | Share of sessions recorded in full |
| `onErrorSampleRate` | 1 | Share of the rest that buffer and upload on error |
| `bufferSeconds` | 60 | On-error buffer length (10..300) |
| `requireConsent` | `true` | Record only after consent |
| `maskAllInputs` | `true` | Mask every input value |
| `maskText` | `pii` | `pii` / `all` / `none` |
| `blockClass`, `blockSelector`, `maskTextClass`, `maskTextSelector` | `platform-block`, `[data-platform-block]`, `platform-mask`, `[data-platform-mask]` | Extra classes/selectors |
| `captureNetwork` | `true` | Network markers |
| `snapshotOnNavigation` | `true` | DOM snapshot after SPA route changes |
| `endpoint`, `userId`, `flushIntervalMs`, `maxChunkBytes` | — / — / 5000 / 65536 | |

**Demo apps.** `examples/sdk-apps/react-web` and `examples/sdk-apps/angular-web` both enable
replay with a consent banner (`Allow session replay` / `Decline`), a Checkout form with personal
data and a `platform-mask` paragraph; set `RUM_REPLAY_ENDPOINT` (k8s Secret `sdk-demo-rum`, key
`replayEndpoint`). Each has a Playwright check, `e2e/replay.mjs` (Angular: `ANGULAR_URL`,
`BROWSER=chromium|firefox|webkit`; it also verifies the final short page and error linking).
See [examples/sdk-apps/README.md](../../examples/sdk-apps/README.md#session-replay-40).

## Backpressure

The SDK ships its own small Faro transport: `Authorization: Bearer <browser token>`, batches
from Faro's batch executor, `keepalive` for page-hide flushes, `Retry-After` honoured on
429/503, exponential backoff with jitter on network errors/5xx, a bounded queue (30 batches)
whose overflow is dropped and counted, and no retries for other 4xx. It never throws into
the app.

## Where the data shows up

Web vitals appear per page (p75) in **Project → Observability → RUM**, and browser spans join
backend traces in Tempo. See [Observability views](observability.md).

## Collector notes

- CORS on the Faro receiver allows the `Authorization` and `Content-Type` request headers
  and exposes `Retry-After`. Its origin list is maintained by the platform API from every
  project's browser origins: environment hosts, the project domain and
  `TELEMETRY_ALLOWED_ORIGINS` (e.g. `https://shop.example.com, https://*.preview.example.com,
  http://localhost:4200`). After you change the variable, allow up to about two minutes
  before the collector accepts the new origin; the browser token picks it up at its next
  config refresh.
- When a browser token exceeds its ingest budget the collector answers `429` with
  `Retry-After` and CORS headers, so the transport waits as asked.
- Backends that receive `traceparent` cross-origin must allow it in
  `Access-Control-Allow-Headers` (the `cors` npm package reflects requested headers by default).
