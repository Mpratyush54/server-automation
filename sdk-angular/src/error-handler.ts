import { Injectable, Inject, ErrorHandler, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_CONFIG, PlatformConfig } from './platform-config';

@Injectable()
export class PlatformErrorHandler implements ErrorHandler {
  constructor(
    @Inject(PLATFORM_CONFIG) private config: PlatformConfig,
    private injector: Injector,
  ) {}

  handleError(error: any): void {
    const message = error?.message || String(error);
    const stack = error?.stack || '';
    const http = this.injector.get(HttpClient);

    try {
      http.post(`${this.config.apiBase}/api/sdk/bug-report`, {
        projectId: this.config.projectId,
        environment: this.config.environment || 'production',
        description: message,
        category: 'angular-error',
        consoleLogs: [
          { level: 'error', message, stack },
        ],
        browserInfo: {
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
          url: typeof window !== 'undefined' ? window.location.href : '',
        },
        appState: {},
      }).subscribe({ error: () => {} });
    } catch {}

    console.error('[Platform] Unhandled error:', error);
  }
}
