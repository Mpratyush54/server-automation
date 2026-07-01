# BugReporterWidget

A floating bug-report button (bottom-right corner) that opens a drawer for users to describe issues. Automatically captures **console logs**, **network timeline**, and a **screenshot** (via `html2canvas`).

---

## Import

```tsx
import { BugReporterWidget } from '@mpratyush54/sdk-react';
```

---

## Props

```typescript
interface BugReporterWidgetProps {
  config: PlatformConfig;
}
```

See [`PlatformProvider`](PlatformProvider.md) for the `PlatformConfig` shape.

---

## Behaviour

- Renders a red 🐛 **floating action button** (fixed, `z-index: 99999`, bottom-right).
- Clicking toggles a dark-themed drawer:
  - **Textarea** for the user's description.
  - Hint that console logs, network history, and a screenshot will be attached automatically.
  - **Cancel** and **Submit Report** buttons.
- On submit:
  1. Captures a full-page screenshot via `html2canvas` (lazy-imported).
  2. POSTs to `POST /api/sdk/bug-report` with:
     - `description`
     - `category: 'user-report'`
     - `consoleLogs` — captured from patched `console.log/warn/error` (max 100 entries)
     - `networkTimeline` — captured from patched `window.fetch` (max 100 entries)
     - `screenshotBase64` — base64-encoded PNG
     - `browserInfo` — `userAgent`, `url`, `viewport`
     - `appState` — empty object (extendable)
- On success: shows a green "Bug report submitted" message for 2 s and closes.
- On failure: shows `alert('Failed to submit bug report.')`.

---

## Full Example

```tsx
import { PlatformProvider, BugReporterWidget } from '@mpratyush54/sdk-react';

export default function App() {
  const platformConfig = {
    apiBase: 'https://platform.example.com',
    token: process.env.NEXT_PUBLIC_PLATFORM_TOKEN!,
    projectId: 'my-app',
    environment: 'production',
  };

  return (
    <PlatformProvider config={platformConfig}>
      <YourApp />
      <BugReporterWidget config={platformConfig} />
    </PlatformProvider>
  );
}
```

---

## Notes

- Console and `fetch` patching begins when the component mounts and is restored on unmount.
- A screenshot is taken **only at submit time** (not continuously).
- `html2canvas` (~40 KB gzipped) is lazy-loaded via dynamic `import()` on first submit.
