# @mpratyush54/sdk-react

The official React and Next.js SDK for the Platform.

This SDK provides frontend integrations for React applications, including global HTTP interception, React Context for configuration, Error Boundaries for unified error handling, and a drop-in Bug Reporter UI component.

## Installation

```bash
npm install @mpratyush54/sdk-react
```

## Features

- **Context Provider:** Exposes the SDK globally to all your React components.
- **HTTP Interceptor:** Automatically records network timings and errors.
- **Error Boundary:** Catches unhandled React render errors and logs them to the Platform.
- **Bug Reporter Component:** A UI component (`<BugReporter />`) that lets users report issues with screenshots.

## Usage

In your root `App.tsx` or Next.js `layout.tsx`:

```tsx
import { PlatformProvider, ErrorBoundary, BugReporter } from '@mpratyush54/sdk-react';

export default function App({ children }) {
  return (
    <PlatformProvider
      projectId="your-project-id"
      environment="production"
      apiUrl="https://api.your-platform.com"
    >
      <ErrorBoundary>
        {children}
        <BugReporter />
      </ErrorBoundary>
    </PlatformProvider>
  );
}
```
