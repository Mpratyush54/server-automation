import { Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-database-insights-panel', standalone: true,
  imports: [CommonModule, FormsModule],
  template: `<section class="card" style="padding:24px;overflow:auto" aria-label="Database insights">
    <h2>Database insights</h2>
    <label>Environment <select [(ngModel)]="environment" (change)="reset()">
      @for (e of project?.environments || []; track e.name) { <option [value]="e.name">{{e.name}}</option> }
    </select></label>
    <button (click)="load()" [disabled]="busy">Refresh</button><p role="status">{{message}}</p>
    @if (data?.enabled) {
      <p>Collected {{data.collectedAt | date:'medium'}}. Top 20 PostgreSQL queries by total execution time, cumulative since statistics reset.</p>
      <p>PostgreSQL: {{data.postgres.status}} · Connections {{data.postgres.connections ?? '—'}} · Size {{data.postgres.sizeBytes ?? '—'}} bytes</p>
      <table><thead><tr><th>Query shape</th><th>Calls</th><th>Rows</th><th>Mean ms</th><th>Total ms</th></tr></thead><tbody>
      @for (q of data.postgres.topQueries || []; track $index) { <tr><td><code>{{q.query}}</code></td><td>{{q.calls}}</td><td>{{q.rows}}</td><td>{{q.latencyMs | number:'1.1-2'}}</td><td>{{q.totalMs | number:'1.1-2'}}</td></tr> }
      </tbody></table>
      <p>MongoDB: {{data.mongo.status}} · Size {{data.mongo.sizeBytes ?? '—'}} bytes · Slow operations ≥ {{data.slowMs}} ms (last hour)</p>
      <table><thead><tr><th>Operation shape</th><th>Time</th><th>Latency ms</th><th>Rows</th></tr></thead><tbody>
      @for (q of data.mongo.slowQueries || []; track $index) { <tr><td>{{q.query}}</td><td>{{q.at | date:'medium'}}</td><td>{{q.latencyMs}}</td><td>{{q.rows}}</td></tr> }
      </tbody></table>
      <p>Redis: {{data.redis.status}} · Keys {{data.redis.keyCount ?? '—'}} {{data.redis.complete === false ? '(partial scan)' : ''}}. Connections are shared and cannot be attributed reliably.</p>
      <h3>Connection trend during this visit</h3>
      <p>30-second samples, up to 30 minutes. Switching environments clears samples.</p>
      <svg viewBox="0 0 600 100" role="img" aria-label="PostgreSQL connection trend" style="max-width:600px;width:100%">
        <polyline [attr.points]="points" fill="none" stroke="currentColor" stroke-width="2" />
      </svg>
      <p>Database span navigation will be available with the Observability traces view.</p>
    }
  </section>`,
})
export class DatabaseInsightsPanelComponent implements OnChanges, OnDestroy {
  @Input() project: any;
  private http = inject(HttpClient);
  environment = 'production'; data: any; message = ''; busy = false;
  samples: number[] = []; private timer?: ReturnType<typeof setInterval>; private generation = 0;
  get points() { const max = Math.max(1, ...this.samples); return this.samples.map((n,i) => `${i * 600 / Math.max(1,this.samples.length-1)},${95-n/max*90}`).join(' '); }
  ngOnChanges() { this.environment = this.project?.environments?.[0]?.name || 'production'; this.reset(); if (!this.timer) this.timer = setInterval(() => void this.load(),30000); }
  ngOnDestroy() { this.generation++; if (this.timer) clearInterval(this.timer); }
  reset() { this.generation++; this.busy = false; this.samples = []; this.data = null; void this.load(); }
  async load() {
    if (this.busy || !this.project?.id) return;
    const generation = this.generation; this.busy = true;
    try {
      const data = await firstValueFrom(this.http.get<any>(`/api/projects/${encodeURIComponent(this.project.id)}/databases/insights`, {params:{environment:this.environment}}));
      if (generation !== this.generation) return;
      this.data = data; this.message = data.enabled ? '' : data.reason;
      if (typeof data.postgres?.connections === 'number') this.samples = [...this.samples.slice(-59),data.postgres.connections];
    } catch { if (generation === this.generation) this.message = 'Database insights unavailable. Try refreshing.'; }
    finally { if (generation === this.generation) this.busy = false; }
  }
}
