import { Component } from '@angular/core';
import { ApiLog } from './api-log';

@Component({
  selector: 'app-home',
  standalone: true,
  template: `
    <p style="color:#555">
      Browser traffic → Node Express → Platform SDK metrics. With RUM enabled the browser also reports web vitals,
      errors, resource timings, clicks and a client span per HttpClient call, linked to the backend trace via
      <code>traceparent</code>.
    </p>
    <div>
      <button [disabled]="api.busy" (click)="api.hit('/api/hello')">GET /api/hello</button>
      <button [disabled]="api.busy" (click)="api.hit('/api/users')">GET /api/users</button>
      <button [disabled]="api.busy" (click)="api.hit('/api/orders', 'POST', { item: 'angular-widget', qty: 1 })">POST /api/orders</button>
      <button [disabled]="api.busy" (click)="api.hit('/api/slow')">GET /api/slow</button>
      <button [disabled]="api.busy" (click)="api.hit('/api/db-check')">GET /api/db-check</button>
      <button data-rum-name="throw-error" (click)="fail()">Throw JS error</button>
    </div>
    <pre>{{ api.text || 'No requests yet.' }}</pre>
  `,
})
export class HomeComponent {
  constructor(public api: ApiLog) {}

  fail(): void {
    throw new Error('demo error from angular-web');
  }
}
