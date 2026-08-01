# Angular SDK Quickstart

Instrument an Angular app with HTTP metrics, a global error handler, and a bug-reporter component.

Package: [`@mpratyush54/sdk-angular`](https://www.npmjs.com/package/@mpratyush54/sdk-angular) · Examples: [`sdk-angular/examples`](../../sdk-angular/examples)

## Installation

```bash
npm install @mpratyush54/sdk-angular
```

## NgModule setup

Config fields are `apiBase` / `token` / `projectId` (not `apiUrl` / `sdkToken`):

```ts
import { PlatformModule } from '@mpratyush54/sdk-angular';

@NgModule({
  imports: [
    HttpClientModule,
    PlatformModule.forRoot({
      apiBase: 'https://api.example.sslip.io',
      token: 'sdk_live_…',
      projectId: 'your-project-id',
      environment: 'development',
      appName: 'my-angular-app',
    }),
  ],
})
export class AppModule {}
```

Template:

```html
<platform-bug-reporter></platform-bug-reporter>
```

## Standalone bootstrap

```ts
import { importProvidersFrom } from '@angular/core';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { PlatformModule } from '@mpratyush54/sdk-angular';

bootstrapApplication(AppComponent, {
  providers: [
    provideHttpClient(withInterceptorsFromDi()),
    importProvidersFrom(
      PlatformModule.forRoot({
        apiBase: environment.platformUrl,
        token: environment.sdkToken,
        projectId: environment.projectId,
      }),
    ),
  ],
});
```

See [`sdk-angular/examples/app.config.ts`](../../sdk-angular/examples/app.config.ts).

## What is registered

| Provider | Role |
|----------|------|
| `PlatformHttpInterceptor` | Times `HttpClient` → `/api/sdk/api-metrics` |
| `PlatformErrorHandler` | Global `ErrorHandler` |
| `BugReporterComponent` | `<platform-bug-reporter>` |

## More examples

| Path | Topic |
|------|--------|
| [`app.module.ts`](../../sdk-angular/examples/app.module.ts) | NgModule |
| [`app.config.ts`](../../sdk-angular/examples/app.config.ts) | Standalone |
| [`usage.component.ts`](../../sdk-angular/examples/usage.component.ts) | HttpClient + reporter |
| [`examples/sdk-apps/angular-web`](../../examples/sdk-apps/angular-web) | Deployed demo |

## API reference

[PlatformModule](../api-reference/sdk-angular/PlatformModule.md) · [HTTP Interceptor](../api-reference/sdk-angular/PlatformHttpInterceptor.md) · [Error Handler](../api-reference/sdk-angular/PlatformErrorHandler.md) · [Bug Reporter](../api-reference/sdk-angular/BugReporterComponent.md)
