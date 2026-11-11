# BugReporterWidget

A floating bug-report button (bottom-right corner) that opens a drawer for users to describe issues. Attaches recent **console logs** and the **request timeline** (credentials redacted). A **screenshot** (via `html2canvas`) is attached only when you opt in with `captureScreenshot`.

---

## Import

```tsx
import { BugReporterWidget } from '@mpratyush54/sdk-react';
```

---

## Props

```typescript
interface BugReporterWidgetProps {
  config?: PlatformConfig;        // defaults to the enclosing <PlatformProvider>'s config
  captureScreenshot?: boolean;    // default false
}
```

See [`PlatformProvider`](PlatformProvider.md) for the `PlatformConfig` shape.

---

## Behaviour

- Renders a red 🐛 **floating action button** (fixed, `z-index: 99999`, bottom-right).
- Clicking toggles a dark-themed drawer:
  - **Textarea** for the user's description.
  - Hint describing what is attached; with `captureScreenshot`, a checkbox the user can untick to skip the screenshot.
  - **Cancel** and **Submit Report** buttons.
- On submit:
  1. Only if `captureScreenshot` is set and the box is ticked: captures the page via `html2canvas` (lazy-imported). Password, payment (`autocomplete="cc-*"`), one-time-code and `data-platform-mask` fields are blanked in the cloned DOM first, and the widget itself is excluded.
  2. POSTs to `POST /api/sdk/bug-report` (`Authorization: Bearer <token>`) with:
     - `description`
     - `category: 'user-report'`
     - `consoleLogs` — captured from patched `console.log/warn/error` (max 100 entries), with Authorization/Bearer values, SDK tokens, JWTs, cookies and password-like fields redacted
     - `networkTimeline` — method, redacted URL, status and duration from patched `window.fetch` (max 100 entries; no headers or bodies)
     - `screenshotBase64` — base64-encoded PNG, or `null` when not opted in
     - `browserInfo` — `userAgent`, `url` (redacted), `viewport`
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
- Screenshots are **off by default**. When enabled, one is taken **only at submit time** (not continuously). Mark any other sensitive element with `data-platform-mask` to blank it.
- `html2canvas` (~40 KB gzipped) is lazy-loaded via dynamic `import()` on first submit.
