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

1. Records `Date.now()` at request start.
2. Wraps the `next.handle()` observable.
3. On **successful completion**: sends a metric with `statusCode: 200` and the measured duration.
4. On **error**: sends a metric with the actual HTTP error status code and the measured duration.
5. POSTs to `POST /api/sdk/api-metrics` with:
   - `projectId`, `environment`
   - `route` — the full request URL (with params)
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
      token: 'sk-xxxx',
      projectId: 'my-app',
    }),
  ],
})
export class AppModule {}
```

---

## Behaviour

- Intercepts **all** `HttpClient` calls (GET, POST, PUT, DELETE, etc.).
- Does **not** modify the request or response — it only observes and reports.
- The metric POST uses a fire-and-forget `.subscribe()` — errors are silently swallowed.

---

## Error Handling

- Interceptor failures are **silent** — they never propagate to the calling code.
- If the metric POST itself fails, it is ignored (`.subscribe({ error: () => {} })`).
