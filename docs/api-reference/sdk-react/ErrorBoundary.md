# ErrorBoundary

A React class component that catches JavaScript errors anywhere in its child component tree, logs those errors to the Platform API, and displays a fallback UI.

---

## Import

```tsx
import { ErrorBoundary } from '@mpratyush54/sdk-react';
```

---

## Props

```typescript
interface ErrorBoundaryProps {
  config: PlatformConfig;
  children: ReactNode;
  fallback?: ReactNode;
}
```

| Prop | Type | Description |
|---|---|---|
| `config` | `PlatformConfig` | Platform configuration (see [`PlatformProvider`](PlatformProvider.md)) |
| `children` | `ReactNode` | Component tree to wrap |
| `fallback?` | `ReactNode` | Custom error UI (defaults to a red "Something went wrong" message) |

---

## Behaviour

1. Catches errors via `componentDidCatch(error, errorInfo)`.
2. POSTs a bug report to `POST /api/sdk/bug-report` with:
   - `category: 'react-crash'`
   - `description`: `error.message`
   - `consoleLogs`: error message, stack trace, and component stack
   - `browserInfo`: `userAgent` and current URL
3. Renders the `fallback` prop if provided, or a default error message.

---

## Full Example

```tsx
import { PlatformProvider, ErrorBoundary } from '@mpratyush54/sdk-react';

function App() {
  const config = {
    apiBase: 'https://platform.example.com',
    token: process.env.NEXT_PUBLIC_PLATFORM_TOKEN!,
    projectId: 'my-app',
  };

  return (
    <PlatformProvider config={config}>
      <ErrorBoundary config={config} fallback={<h1>Something broke!</h1>}>
        <YourApp />
      </ErrorBoundary>
    </PlatformProvider>
  );
}
```

---

## Error Handling

- The bug-report POST is wrapped in a try/catch — a failure to report **never** crashes the app.
- Only errors in the **rendering phase** are caught. Event handler errors are not captured by `ErrorBoundary` (use `try/catch` in those cases).
