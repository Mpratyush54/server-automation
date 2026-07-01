# PlatformModule

Angular module that integrates the Platform SDK into your application. Provides HTTP metrics interception, global error handling, and the bug-reporter component.

---

## Installation

```bash
npm install @mpratyush54/sdk-angular
```

Requires **Angular >= 16** and **RxJS >= 7**.

---

## Import

```typescript
import { PlatformModule } from '@mpratyush54/sdk-angular';
```

---

## `forRoot(config)` — Module configuration

```typescript
@NgModule({
  imports: [PlatformModule.forRoot(config: PlatformConfig)],
})
```

### `PlatformConfig`

| Property | Type | Description |
|---|---|---|
| `apiBase` | `string` | **Required.** Platform API base URL |
| `token` | `string` | **Required.** SDK bearer token |
| `projectId` | `string` | **Required.** Your Platform project ID |
| `environment?` | `string` | Environment label (default `'production'` in metrics) |
| `appName?` | `string` | Optional application name |

---

## Provided Services

`PlatformModule.forRoot()` registers the following providers:

| Token | Class | Scope |
|---|---|---|
| `HTTP_INTERCEPTORS` | `PlatformHttpInterceptor` | Multi — intercepts all `HttpClient` calls |
| `ErrorHandler` | `PlatformErrorHandler` | Global Angular error handler |
| `PLATFORM_CONFIG` | value (config object) | Injection token for runtime access |

---

## Full Example

```typescript
// app.module.ts
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
      apiBase: 'https://platform.example.com',
      token: 'sk-xxxx',
      projectId: 'my-angular-app',
      environment: 'production',
    }),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
```

---

## Using BugReporterComponent

```typescript
// app.component.ts
import { Component } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    <router-outlet></router-outlet>
    <platform-bug-reporter></platform-bug-reporter>
  `,
})
export class AppComponent {}
```

The `<platform-bug-reporter>` component is exported by `PlatformModule` so it's available globally.

---

## Error Handling

- The module itself does not throw during configuration. If `forRoot()` is omitted, `PLATFORM_CONFIG` will not be provided and the interceptor / error handler will fail at runtime when they try to inject it.
- Metric and error-report POST failures are **silent** (`.subscribe({ error: () => {} })`).
