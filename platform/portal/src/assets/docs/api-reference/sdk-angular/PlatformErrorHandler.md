# PlatformErrorHandler

An Angular `ErrorHandler` implementation that captures unhandled exceptions and forwards them to the Platform bug-report API.

---

## Import

```typescript
import { PlatformErrorHandler } from '@mpratyush54/sdk-angular';
```

Registered automatically by `PlatformModule.forRoot()` — you typically do not use this class directly.

---

## How It Works

1. Angular calls `handleError(error)` when an unhandled exception occurs.
2. Extracts `error.message` and `error.stack`.
3. POSTs to `POST /api/sdk/bug-report` with:
   - `projectId`, `environment`
   - `description` — `error.message`
   - `category: 'angular-error'`
   - `consoleLogs` — single entry with level `error`, the message, and stack trace
   - `browserInfo` — `userAgent` and current URL
   - `appState` — empty object
4. Falls back to `console.error('[Platform] Unhandled error:', error)`.

---

## Registration

```typescript
import { PlatformModule } from '@mpratyush54/sdk-angular';

@NgModule({
  imports: [
    PlatformModule.forRoot({
      apiBase: 'https://platform.example.com',
      token: 'sk-xxxx',
      projectId: 'my-app',
    }),
  ],
})
export class AppModule {}
```

---

## Error Handling

- The bug-report POST is wrapped in a try/catch — a failure to report **never** causes a secondary error.
- The original error is still logged to the console after reporting.
- Only errors that Angular routes to the `ErrorHandler` are captured (unhandled promises, zone errors, etc.).
