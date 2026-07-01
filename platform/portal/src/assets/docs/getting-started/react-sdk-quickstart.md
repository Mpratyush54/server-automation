# React SDK Quickstart

Instrument your React application with error boundaries, bug reporting, and automatic metrics.

## Installation

```bash
npm install @mpratyush54/sdk-react
```

## Basic Setup

Wrap your application root with `PlatformProvider` and `ErrorBoundary`:

```tsx
import { PlatformProvider, ErrorBoundary, BugReporterWidget } from '@mpratyush54/sdk-react';

function App() {
  return (
    <PlatformProvider
      apiUrl="http://localhost:3000"
      sdkToken="sdk_xxxxx"
      projectId="proj-xxxxx"
    >
      <ErrorBoundary>
        <YourApp />
      </ErrorBoundary>
      <BugReporterWidget />
    </PlatformProvider>
  );
}
```

## Hooks

Access platform features from any child component:

```tsx
import { usePlatform, useBugReporter } from '@mpratyush54/sdk-react';

function MyComponent() {
  const platform = usePlatform();
  const reporter = useBugReporter();

  // Track a custom metric
  platform.metrics.trackEvent('button_click', { buttonId: 'submit' });

  // Report a bug with screenshot
  const handleReportBug = () => {
    reporter.open({ category: 'ui', severity: 'minor' });
  };

  return <button onClick={handleReportBug}>Report Bug</button>;
}
```

## Components

| Component | Purpose |
|---|---|
| `PlatformProvider` | Context provider — initializes the SDK and makes it available to all children |
| `ErrorBoundary` | Catches React render errors and reports them to the platform |
| `BugReporterWidget` | Floating widget (bottom-right) that users can click to submit bug reports with screenshots |

## Environment-Specific Config

```tsx
const config = {
  development: {
    apiUrl: 'http://localhost:3000',
    sdkToken: process.env.REACT_APP_SDK_TOKEN!,
    projectId: process.env.REACT_APP_PROJECT_ID!,
  },
  production: {
    apiUrl: 'https://platform.yourdomain.com',
    sdkToken: process.env.REACT_APP_SDK_TOKEN!,
    projectId: process.env.REACT_APP_PROJECT_ID!,
  },
}[process.env.NODE_ENV || 'development'];

function App() {
  return (
    <PlatformProvider {...config}>
      <ErrorBoundary>
        <MainRouter />
      </ErrorBoundary>
      <BugReporterWidget />
    </PlatformProvider>
  );
}
```

## API Reference

See the full [React SDK API Reference](../api-reference/sdk-react/PlatformProvider.md).
