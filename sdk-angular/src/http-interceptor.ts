import { Injectable, Inject } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { HttpBackend, HttpClient } from '@angular/common/http';
import { PLATFORM_CONFIG, PlatformConfig } from './platform-config';
import { isPlatformSdkUrl, platformHeaders, redactSensitive } from './platform-http';

@Injectable()
export class PlatformHttpInterceptor implements HttpInterceptor {
  /**
   * Telemetry goes straight to HttpBackend so it never re-enters the
   * HTTP_INTERCEPTORS chain (which would meter the metric call itself, forever).
   */
  private readonly http: HttpClient;

  constructor(
    @Inject(PLATFORM_CONFIG) private config: PlatformConfig,
    backend: HttpBackend,
  ) {
    this.http = new HttpClient(backend);
  }

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Never meter the SDK's own Platform API calls.
    if (isPlatformSdkUrl(this.config, req.url)) {
      return next.handle(req);
    }
    const start = Date.now();

    return next.handle(req).pipe(
      catchError((error: HttpErrorResponse) => {
        const duration = Date.now() - start;
        this.sendMetric(req, error.status, duration);
        return throwError(() => error);
      }),
      (events) => {
        return new Observable<HttpEvent<any>>((subscriber) => {
          events.subscribe({
            next: (event) => {
              subscriber.next(event);
            },
            error: (err) => subscriber.error(err),
            complete: () => {
              const duration = Date.now() - start;
              this.sendMetric(req, 200, duration);
              subscriber.complete();
            },
          });
        });
      }
    );
  }

  private sendMetric(req: HttpRequest<any>, statusCode: number, durationMs: number): void {
    try {
      this.http.post(`${this.config.apiBase}/api/sdk/api-metrics`, {
        projectId: this.config.projectId,
        environment: this.config.environment || 'production',
        route: redactSensitive(req.urlWithParams),
        method: req.method.toUpperCase(),
        statusCode,
        durationMs,
      }, { headers: platformHeaders(this.config) }).subscribe({ error: () => {} });
    } catch {}
  }
}
