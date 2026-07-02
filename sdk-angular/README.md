# @mpratyush54/sdk-angular

The official Angular SDK for the Platform.

This SDK provides frontend integrations for Angular applications, including global HTTP interception for metrics, unified error handling, and a drop-in bug reporting component.

## Installation

```bash
npm install @mpratyush54/sdk-angular
```

## Features

- **HTTP Interceptor:** Automatically records network timings and errors for all outbound HTTP requests.
- **Error Handler:** Catches unhandled exceptions and logs them to the Platform.
- **Bug Reporter Component:** A UI component (`<platform-bug-reporter>`) that lets users report issues with screenshots and console logs.

## Usage

In your `app.module.ts` or `app.config.ts`:

```typescript
import { PlatformSdkModule } from '@mpratyush54/sdk-angular';

@NgModule({
  imports: [
    PlatformSdkModule.forRoot({
      projectId: 'your-project-id',
      environment: 'production',
      apiUrl: 'https://api.your-platform.com'
    })
  ]
})
export class AppModule { }
```
