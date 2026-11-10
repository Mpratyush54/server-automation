# React SDK Quickstart

Instrument a React (or Next.js) app with HTTP metrics, an error boundary, and a floating bug reporter.

Package: [`@mpratyush54/sdk-react`](https://www.npmjs.com/package/@mpratyush54/sdk-react) · Examples: [`sdk-react/examples`](../../sdk-react/examples)

## Installation

```bash
npm install @mpratyush54/sdk-react
```

## Setup

> **Use a browser SDK token.** In the portal open Project → SDK Tokens and create a token of kind
> **Browser**. Anything in frontend config (`VITE_*`, `NEXT_PUBLIC_*`, Angular `environment.ts`) is
> bundled into public JavaScript, so never put a **Server** token there. Browser tokens can only
> send bug reports, logs and API metrics; they cannot read project config, secrets or database
> credentials. If an SDK token was previously embedded in a frontend, revoke it and create a new
> one (a browser token for the frontend, a server token for your backend).

`PlatformProvider` takes a **`config` object** (not flat props):

```tsx
import {
  PlatformProvider,
  ErrorBoundary,
  BugReporterWidget,
  usePlatform,
} from '@mpratyush54/sdk-react';

const config = {
  apiBase: import.meta.env.VITE_PLATFORM_URL,
  token: import.meta.env.VITE_PLATFORM_BROWSER_TOKEN, // browser-kind SDK token
  projectId: import.meta.env.VITE_PLATFORM_PROJECT_ID,
  environment: 'development',
  appName: 'my-web',
};

export function App() {
  return (
    <PlatformProvider config={config}>
      <ErrorBoundary config={config}>
        <Home />
      </ErrorBoundary>
      <BugReporterWidget config={config} />
    </PlatformProvider>
  );
}

function Home() {
  const { api, config: cfg } = usePlatform();

  return (
    <button
      type="button"
      onClick={async () => {
        const { data } = await api.get('/api/health');
        console.log(cfg.projectId, data);
      }}
    >
      Ping
    </button>
  );
}
```

Calls made with the context `api` Axios client are timed and posted to `/api/sdk/api-metrics`.

## Components

| Export | Purpose |
|--------|---------|
| `PlatformProvider` | Context + instrumented Axios |
| `usePlatform()` | `{ config, api }` |
| `ErrorBoundary` | Catch render errors |
| `BugReporterWidget` | Floating reporter (pass same `config`) |

## Next.js App Router

Wrap a **client** layout (see [`sdk-react/examples/nextjs-app-router.tsx`](../../sdk-react/examples/nextjs-app-router.tsx)) using `NEXT_PUBLIC_PLATFORM_*` env vars.

## More examples

| Path | Topic |
|------|--------|
| [`basic-app.tsx`](../../sdk-react/examples/basic-app.tsx) | Provider + hook |
| [`with-bug-reporter.tsx`](../../sdk-react/examples/with-bug-reporter.tsx) | Boundary + widget |
| [`examples/sdk-apps/react-web`](../../examples/sdk-apps/react-web) | Deployed demo |

## API reference

[PlatformProvider](../api-reference/sdk-react/PlatformProvider.md) · [usePlatform](../api-reference/sdk-react/usePlatform.md) · [BugReporterWidget](../api-reference/sdk-react/BugReporterWidget.md) · [ErrorBoundary](../api-reference/sdk-react/ErrorBoundary.md)
