import { Injectable, Inject } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { CAPS_CONFIG, CapsConfig } from './caps-config';

@Injectable()
export class CapsHttpInterceptor implements HttpInterceptor {
  constructor(
    @Inject(CAPS_CONFIG) private config: CapsConfig,
    private http: HttpClient,
  ) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
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
        route: req.urlWithParams,
        method: req.method.toUpperCase(),
        statusCode,
        durationMs,
      }).subscribe({ error: () => {} });
    } catch {}
  }
}
