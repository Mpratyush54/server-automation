import { Injectable, Inject, ErrorHandler, Injector } from '@angular/core';
import { HttpBackend, HttpClient } from '@angular/common/http';
import { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
import { platformHeaders, redactSensitive } from './platform-http';

@Injectable()
export class PlatformErrorHandler implements ErrorHandler {
  constructor(
    @Inject(PLATFORM_CONFIG) private config: PlatformConfig,
    private injector: Injector,
  ) {}

  handleError(error: any): void {
    const message = redactSensitive(error?.message || String(error));
    const stack = redactSensitive(error?.stack || '');

    try {
      // HttpBackend bypasses app interceptors (no metrics loop, no foreign headers).
      const http = new HttpClient(this.injector.get(HttpBackend));
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
          url: typeof window !== 'undefined' ? redactSensitive(window.location.href) : '',
        },
        appState: {},
      }, { headers: platformHeaders(this.config) }).subscribe({ error: () => {} });
    } catch {}

    console.error('[Platform] Unhandled error:', error);
  }
}
