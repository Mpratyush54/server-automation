'use client';

/**
 * Next.js App Router — mark as client component and wrap children in app/layout.tsx:
 *
 *   import { PlatformRoot } from '../examples/nextjs-app-router';
 *   export default function Layout({ children }) {
 *     return <html><body><PlatformRoot>{children}</PlatformRoot></body></html>;
 *   }
 */
import React, { ReactNode } from 'react';
import {
  PlatformProvider,
  ErrorBoundary,
  BugReporterWidget,
  PlatformConfig,
} from '@mpratyush54/sdk-react';

const config: PlatformConfig = {
  apiBase: process.env.NEXT_PUBLIC_PLATFORM_URL || '',
  token: process.env.NEXT_PUBLIC_PLATFORM_SDK_TOKEN || '',
  projectId: process.env.NEXT_PUBLIC_PLATFORM_PROJECT_ID || '',
  environment: process.env.NEXT_PUBLIC_PLATFORM_ENV || 'production',
  appName: 'nextjs-example',
};

export function PlatformRoot({ children }: { children: ReactNode }) {
  return (
    <PlatformProvider config={config}>
      <ErrorBoundary>{children}</ErrorBoundary>
      <BugReporterWidget config={config} />
    </PlatformProvider>
  );
}
