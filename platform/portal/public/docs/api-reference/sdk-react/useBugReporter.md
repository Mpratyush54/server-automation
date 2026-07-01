# useBugReporter

> **Note:** The React SDK does not export a dedicated `useBugReporter` hook. Bug reporting is handled through the [`BugReporterWidget`](BugReporterWidget.md) component and the [`ErrorBoundary`](ErrorBoundary.md) component.

If you need programmatic bug reporting, read the `config` from `usePlatform()` and POST directly to the bug-report endpoint:

```tsx
import axios from 'axios';
import { usePlatform } from '@mpratyush54/sdk-react';

function useBugReporter() {
  const { config } = usePlatform();

  return async (description: string) => {
    await axios.post(`${config.apiBase}/api/sdk/bug-report`, {
      projectId: config.projectId,
      environment: config.environment || 'production',
      description,
      category: 'user-report',
      consoleLogs: [],       // optionally capture console entries
      browserInfo: {
        userAgent: navigator.userAgent,
        url: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      },
      appState: {},
    }, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
  };
}
```

---

## Related Components

| Component | Purpose |
|---|---|
| [`BugReporterWidget`](BugReporterWidget.md) | Floating bug-report button + drawer with screenshot / console / network capture |
| [`ErrorBoundary`](ErrorBoundary.md) | Catches React render errors and auto-submits a bug report |
