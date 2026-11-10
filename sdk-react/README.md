# @mpratyush54/sdk-react

Official React SDK for Platform — provider context, automatic HTTP metrics, error boundary, and a floating bug reporter.

**Requires React ≥ 18.** Package: [`@mpratyush54/sdk-react`](https://www.npmjs.com/package/@mpratyush54/sdk-react)

## Install

```bash
npm install @mpratyush54/sdk-react
```

## Quick start

```tsx
import {
  PlatformProvider,
  ErrorBoundary,
  BugReporterWidget,
  usePlatform,
} from '@mpratyush54/sdk-react';

const platformConfig = {
  apiBase: import.meta.env.VITE_PLATFORM_URL,   // or process.env.REACT_APP_…
  token: import.meta.env.VITE_PLATFORM_SDK_TOKEN,
  projectId: import.meta.env.VITE_PLATFORM_PROJECT_ID, // UUID or project name used by API metrics
  environment: 'development',
  appName: 'my-web',
};

export function App() {
  return (
    <PlatformProvider config={platformConfig}>
      <ErrorBoundary config={platformConfig}>
        <Dashboard />
      </ErrorBoundary>
      <BugReporterWidget config={platformConfig} />
    </PlatformProvider>
  );
}

function Dashboard() {
  const { api, config } = usePlatform();

  async function load() {
    // Calls through `api` are timed and sent to POST /api/sdk/api-metrics
    const { data } = await api.get('/api/health');
    console.log(config.projectId, data);
  }

  return <button onClick={load}>Ping API</button>;
}
```

## Exports

| Export | Role |
|--------|------|
| `PlatformProvider` | Context + Axios client (sends `Authorization: Bearer <token>`) with latency interceptors; metrics go out on a separate client |
| `usePlatform()` | `{ config, api }` — must be under the provider |
| `ErrorBoundary` | Catches render errors and reports them (`config` prop, or the enclosing provider's) |
| `BugReporterWidget` | Floating 🐛 UI; attaches redacted console + request-URL history; screenshot only with `captureScreenshot` |
| `useRumPageView(location)` | One RUM view per route change (react-router v6/v7 `useLocation()`) |
| `initRum` / `setRumView` / `stopRum` / `reportRumError` | RUM runtime without the provider |

## `PlatformConfig`

| Field | Required | Description |
|-------|----------|-------------|
| `apiBase` | yes | Platform API base URL |
| `token` | yes | SDK token (`sdk_live_…` / `sdk_test_…`), sent as `Authorization: Bearer` |
| `projectId` | yes | Project id used when posting metrics |
| `environment` | no | Default `production` in metric payloads |
| `appName` | no | App label |
| `rum` | no | Frontend RUM via Grafana Faro (web vitals, errors, resources, clicks, routes, `traceparent`). Off when omitted: nothing is loaded |

## Frontend RUM

```tsx
<PlatformProvider config={{ ...config, rum: { telemetryUrl: '/rum-config.json', propagateTo: ['https://api.example.com'] } }}>
```

Faro is a lazy chunk (about 18 KB gzip, +1 KB in the initial chunk), fetched only when RUM is
enabled by the platform, allowed by Do-Not-Track and sampled in. No PII by default. Measure with
`npm run size`. Full guide: [docs/guides/frontend-rum.md](../docs/guides/frontend-rum.md).

## Examples

| File | Topic |
|------|--------|
| [`examples/basic-app.tsx`](./examples/basic-app.tsx) | Provider + hook |
| [`examples/with-bug-reporter.tsx`](./examples/with-bug-reporter.tsx) | ErrorBoundary + widget |
| [`examples/nextjs-app-router.tsx`](./examples/nextjs-app-router.tsx) | Next.js App Router client layout |

Full cluster demos: [`examples/sdk-apps/react-web`](../examples/sdk-apps/react-web).

Docs: [React quickstart](../docs/getting-started/react-sdk-quickstart.md) · [API](../docs/api-reference/sdk-react/PlatformProvider.md)

## License

MIT
