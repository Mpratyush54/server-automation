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
| Initial chunk added by RUM | +1.0 KB | +1.0 KB |
| Lazy Faro chunk (only when enabled + sampled) | 18.0 KB | 18.0 KB |
| Total when enabled (budget < 30 KB) | 19.0 KB | 19.0 KB |

In the demo apps the lazy chunk is 21.9 KB (Vite, ES2020 target) and 19.2 KB (Angular CLI).
Apps that never use RUM (no provider/module/`initRum`) contain no Faro code at all; apps that
use the provider/module without `rum` get the lazy chunk emitted but never download it.
The size check fails if Faro reaches the initial chunks.

## Backpressure

The SDK ships its own small Faro transport: `Authorization: Bearer <browser token>`, batches
from Faro's batch executor, `keepalive` for page-hide flushes, `Retry-After` honoured on
429/503, exponential backoff with jitter on network errors/5xx, a bounded queue (30 batches)
whose overflow is dropped and counted, and no retries for other 4xx. It never throws into
the app.

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
