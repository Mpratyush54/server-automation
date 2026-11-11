# PlatformHttpInterceptor

An Angular `HttpInterceptor` that automatically measures latency and reports API metrics for every `HttpClient` request.

---

## Import

```typescript
import { PlatformHttpInterceptor } from '@mpratyush54/sdk-angular';
```

Registered automatically by `PlatformModule.forRoot()` — you typically do not import this class directly.

---

## How It Works

1. Skips the SDK's own Platform calls (`{apiBase}/api/sdk/*`) so telemetry is never metered.
2. Records `Date.now()` at request start.
3. Wraps the `next.handle()` observable.
4. On **successful completion**: sends a metric with `statusCode: 200` and the measured duration.
5. On **error**: sends a metric with the actual HTTP error status code and the measured duration.
6. POSTs to `POST /api/sdk/api-metrics` (with `Authorization: Bearer <token>`) with:
   - `projectId`, `environment`
   - `route` — the request URL (with params; credential-like values redacted)
   - `method`
   - `statusCode`
   - `durationMs`

---

## Registration

```typescript
import { HttpClientModule } from '@angular/common/http';
import { PlatformModule } from '@mpratyush54/sdk-angular';

@NgModule({
  imports: [
    HttpClientModule,
    PlatformModule.forRoot({
      apiBase: 'https://platform.example.com',
      token: 'sdk_live_xxxx',
      projectId: 'my-app',
    }),
  ],
})
export class AppModule {}
```

---

## Behaviour

- Intercepts **all** `HttpClient` calls (GET, POST, PUT, DELETE, etc.).
- Does **not** modify the request or response — it only observes and reports. The SDK token is never added to your app's own requests.
- The metric POST is sent through `HttpBackend`, bypassing `HTTP_INTERCEPTORS`, so it cannot re-enter this (or any other) interceptor.
- The metric POST uses a fire-and-forget `.subscribe()` — errors are silently swallowed.

---

## Error Handling

- Interceptor failures are **silent** — they never propagate to the calling code.
- If the metric POST itself fails, it is ignored (`.subscribe({ error: () => {} })`).
