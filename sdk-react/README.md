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
      <ErrorBoundary>
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
| `PlatformProvider` | Context + Axios client with latency interceptors |
| `usePlatform()` | `{ config, api }` — must be under the provider |
| `ErrorBoundary` | Catches render errors and reports them |
| `BugReporterWidget` | Floating 🐛 UI; attaches console + network snapshots |

## `PlatformConfig`

| Field | Required | Description |
|-------|----------|-------------|
| `apiBase` | yes | Platform API base URL |
| `token` | yes | SDK bearer token |
| `projectId` | yes | Project id used when posting metrics |
| `environment` | no | Default `production` in metric payloads |
| `appName` | no | App label |

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
