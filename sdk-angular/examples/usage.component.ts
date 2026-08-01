import { Component, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BugReporterComponent } from '@mpratyush54/sdk-angular';

/**
 * Example page: HttpClient calls are auto-metered; bug reporter is a floating control.
 */
@Component({
  selector: 'app-sdk-usage',
  standalone: true,
  imports: [BugReporterComponent],
  template: `
    <h1>Angular SDK usage</h1>
    <button type="button" (click)="ping()">Ping platform health</button>
    <pre>{{ result }}</pre>
    <platform-bug-reporter></platform-bug-reporter>
  `,
})
export class SdkUsageComponent {
  private http = inject(HttpClient);
  result = '';

  ping() {
    this.http.get('/api/health').subscribe({
      next: (data) => {
        this.result = JSON.stringify(data, null, 2);
      },
      error: (err) => {
        this.result = err?.message || String(err);
      },
    });
  }
}
