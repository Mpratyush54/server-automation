import React from 'react';
import {
  PlatformProvider,
  ErrorBoundary,
  BugReporterWidget,
  PlatformConfig,
} from '@mpratyush54/sdk-react';

const config: PlatformConfig = {
  apiBase: import.meta.env.VITE_PLATFORM_URL,
  token: import.meta.env.VITE_PLATFORM_SDK_TOKEN,
  projectId: import.meta.env.VITE_PLATFORM_PROJECT_ID,
  environment: 'development',
};

function Boom() {
  const [n, setN] = React.useState(0);
  if (n > 0) throw new Error('Intentional render crash for ErrorBoundary demo');
  return (
    <button type="button" onClick={() => setN(1)}>
      Crash render
    </button>
  );
}

/** ErrorBoundary catches Boom; BugReporterWidget lets users file issues with console/network context. */
export default function WithBugReporter() {
  return (
    <PlatformProvider config={config}>
      <ErrorBoundary>
        <h1>Bug reporter + error boundary</h1>
        <Boom />
        <p>Use the floating 🐛 button to submit a report.</p>
      </ErrorBoundary>
      <BugReporterWidget config={config} />
    </PlatformProvider>
  );
}
