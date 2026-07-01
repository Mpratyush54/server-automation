# Angular SDK Quickstart

Instrument your Angular application with HTTP interception, error handling, and bug reporting.

## Installation

```bash
npm install @mpratyush54/sdk-angular
```

## Module Setup

Import `PlatformModule` and configure it with the `forRoot` pattern:

```typescript
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { PlatformModule } from '@mpratyush54/sdk-angular';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [AppComponent],
  imports: [
    BrowserModule,
    PlatformModule.forRoot({
      apiUrl: 'http://localhost:3000',
      sdkToken: 'sdk_xxxxx',
      projectId: 'proj-xxxxx'
    })
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
```

## Features

| Feature | Provider | Description |
|---|---|---|
| HTTP Interceptor | `PlatformHttpInterceptor` | Automatically tracks all HTTP request metrics (route, status, duration, bytes) |
| Error Handler | `PlatformErrorHandler` | Replaces Angular's default `ErrorHandler` — sends uncaught errors to the platform |
| Bug Reporter | `BugReporterComponent` | A dialog component users can open to submit bug reports with screenshots |

## Using the Bug Reporter

```typescript
import { Component } from '@angular/core';
import { BugReporterComponent } from '@mpratyush54/sdk-angular';

@Component({
  template: `<button (click)="reportBug()">Report Bug</button>`
})
export class MyComponent {
  constructor(private bugReporter: BugReporterComponent) {}

  reportBug() {
    this.bugReporter.open({ category: 'ui', severity: 'minor' });
  }
}
```

## Custom Error Handling

The `PlatformErrorHandler` is registered automatically. To extend it:

```typescript
import { ErrorHandler } from '@angular/core';
import { PlatformErrorHandler } from '@mpratyush54/sdk-angular';

export class CustomErrorHandler extends PlatformErrorHandler {
  override handleError(error: any): void {
    // Custom logic before reporting
    console.error('Custom handler:', error);
    super.handleError(error);
  }
}

// In AppModule:
providers: [{ provide: ErrorHandler, useClass: CustomErrorHandler }]
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `apiUrl` | `string` | — | Platform API base URL |
| `sdkToken` | `string` | — | SDK token from Project Settings |
| `projectId` | `string` | — | Project ID (`proj-xxxxx`) |
| `environment` | `string` | `'production'` | Deployment environment |

## API Reference

See the full [Angular SDK API Reference](../api-reference/sdk-angular/PlatformModule.md).
