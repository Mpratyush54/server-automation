# @mpratyush54/sdk-angular

Official Angular SDK for Platform — HTTP metrics interceptor, global error handler, and a standalone bug-reporter component.

**Requires Angular ≥ 16.** Package: [`@mpratyush54/sdk-angular`](https://www.npmjs.com/package/@mpratyush54/sdk-angular)

## Install

```bash
npm install @mpratyush54/sdk-angular
```

## Quick start (NgModule)

```ts
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { HttpClientModule } from '@angular/common/http';
import { PlatformModule } from '@mpratyush54/sdk-angular';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    HttpClientModule,
    PlatformModule.forRoot({
      apiBase: 'https://api.example.sslip.io',
      token: 'sdk_live_…',
      projectId: 'your-project-id',
      environment: 'development',
      appName: 'my-angular-app',
    }),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
```

In a template:

```html
<platform-bug-reporter></platform-bug-reporter>
```

## Standalone / `bootstrapApplication`

```ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { importProvidersFrom } from '@angular/core';
import { PlatformModule, BugReporterComponent } from '@mpratyush54/sdk-angular';
import { AppComponent } from './app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    importProvidersFrom(
      PlatformModule.forRoot({
        apiBase: environment.platformUrl,
        token: environment.sdkToken,
        projectId: environment.projectId,
        environment: 'development',
      }),
    ),
  ],
});
```

Import `BugReporterComponent` into a standalone page and add `<platform-bug-reporter>` to the template.

## What you get

| Piece | Behaviour |
|-------|-----------|
| `PlatformHttpInterceptor` | Times every `HttpClient` call → `/api/sdk/api-metrics` (SDK's own calls are skipped) |
| `PlatformErrorHandler` | Replaces Angular `ErrorHandler`; reports uncaught errors |
| `BugReporterComponent` | Floating reporter; attaches recent console messages (credentials redacted) + browser info |
| `PlatformRumService` | Frontend RUM: `trackRouter(router)` records a view per `NavigationEnd`; started by `forRoot` when `rum` is set |
| `providePlatformRum(rum)` | RUM only, for standalone apps that skip `forRoot` |

## `PlatformConfig`

| Field | Required | Description |
|-------|----------|-------------|
| `apiBase` | yes | Platform API base URL |
| `token` | yes | SDK token (`sdk_live_…` / `sdk_test_…`), sent as `Authorization: Bearer` on every Platform call |
| `projectId` | yes | Project id for metrics / bugs |
| `environment` | no | Environment label |
| `appName` | no | App label |
| `rum` | no | Frontend RUM via Grafana Faro (web vitals, errors, resources, clicks, routes, `traceparent` on HttpClient/fetch to `propagateTo` origins). Off when omitted: nothing is loaded |

## Frontend RUM

```ts
PlatformModule.forRoot({ ...config, rum: { telemetryUrl: '/rum-config.json', propagateTo: ['https://api.example.com'] } });
// AppComponent
constructor(router: Router, rum: PlatformRumService) { rum.trackRouter(router); }
```

Faro is a lazy chunk (about 18 KB gzip, +1 KB in the initial chunk), fetched only when RUM is
enabled by the platform, allowed by Do-Not-Track and sampled in. No PII by default. Measure with
`npm run size`. Full guide: [docs/guides/frontend-rum.md](../docs/guides/frontend-rum.md).

## Examples

| File | Topic |
|------|--------|
| [`examples/app.module.ts`](./examples/app.module.ts) | Classic NgModule setup |
| [`examples/app.config.ts`](./examples/app.config.ts) | Standalone providers |
| [`examples/usage.component.ts`](./examples/usage.component.ts) | HttpClient + bug reporter |

Cluster demo: [`examples/sdk-apps/angular-web`](../examples/sdk-apps/angular-web).

Docs: [Angular quickstart](../docs/getting-started/angular-sdk-quickstart.md) · [API](../docs/api-reference/sdk-angular/PlatformModule.md)

## License

MIT
