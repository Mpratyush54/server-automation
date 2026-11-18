import { Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-database-insights-panel', standalone: true,
  imports: [CommonModule, FormsModule],
  template: `<section class="card card-flush" aria-label="Database insights">
    <div class="card-header">
      <h2>Database health</h2>
      <div class="dbi-controls">
        <label class="dbi-env">
          <select [(ngModel)]="environment" (change)="reset()" aria-label="Database insights environment">
            @for (e of project?.environments || []; track e.name) { <option [value]="e.name">{{e.name}}</option> }
          </select>
        </label>
        <button class="btn btn-sm" type="button" (click)="load()" [disabled]="busy">{{ busy ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>
    <div class="dbi-body">
    @if (message) { <p class="dbi-msg" role="status">{{message}}</p> }
    @if (data?.enabled) {
      <p class="dbi-muted">Updated {{data.collectedAt | date:'medium'}} · <a href="https://cairnpaas.dev/docs/operations/database-monitoring" target="_blank" rel="noopener">Learn more</a></p>

      <div class="dbi-engine">
        <div class="dbi-engine-head">
          <h3>PostgreSQL</h3>
          <span class="badge" [class.badge-active]="data.postgres.status === 'ready'" [class.badge-pending]="data.postgres.status !== 'ready'">{{data.postgres.status}}</span>
          <span class="dbi-stat">Open connections <b>{{data.postgres.connections ?? '—'}}</b></span>
          <span class="dbi-stat">Size <b>{{bytes(data.postgres.sizeBytes)}}</b></span>
        </div>
        <p class="dbi-muted">The 20 queries that took the most time. Values are hidden.</p>
        @if ((data.postgres.topQueries || []).length) {
          <div class="dbi-scroll"><table class="dbi-table"><thead><tr><th>Query</th><th class="num">Calls</th><th class="num">Rows</th><th class="num">Average ms</th><th class="num">Total ms</th></tr></thead><tbody>
          @for (q of data.postgres.topQueries; track $index) { <tr><td><code>{{q.query}}</code></td><td class="num">{{q.calls}}</td><td class="num">{{q.rows}}</td><td class="num">{{q.latencyMs | number:'1.1-2'}}</td><td class="num">{{q.totalMs | number:'1.1-2'}}</td></tr> }
          </tbody></table></div>
        } @else { <p class="dbi-empty">No queries recorded yet.</p> }
      </div>

      <div class="dbi-engine">
        <div class="dbi-engine-head">
          <h3>MongoDB</h3>
          <span class="badge" [class.badge-active]="data.mongo.status === 'ready'" [class.badge-pending]="data.mongo.status !== 'ready'">{{data.mongo.status}}</span>
          <span class="dbi-stat">Size <b>{{bytes(data.mongo.sizeBytes)}}</b></span>
        </div>
        <p class="dbi-muted">Operations slower than {{data.slowMs}} ms in the last hour.</p>
        @if ((data.mongo.slowQueries || []).length) {
          <div class="dbi-scroll"><table class="dbi-table"><thead><tr><th>Operation</th><th>Time</th><th class="num">Latency ms</th><th class="num">Rows</th></tr></thead><tbody>
          @for (q of data.mongo.slowQueries; track $index) { <tr><td><code>{{q.query}}</code></td><td>{{q.at | date:'medium'}}</td><td class="num">{{q.latencyMs}}</td><td class="num">{{q.rows}}</td></tr> }
          </tbody></table></div>
        } @else { <p class="dbi-empty">No slow operations in the last hour.</p> }
      </div>

      <div class="dbi-engine">
        <div class="dbi-engine-head">
          <h3>Redis</h3>
          <span class="badge" [class.badge-active]="data.redis.status === 'ready'" [class.badge-pending]="data.redis.status !== 'ready'">{{data.redis.status}}</span>
          <span class="dbi-stat">Keys <b>{{data.redis.keyCount ?? '—'}}</b>{{data.redis.complete === false ? ' (partial scan)' : ''}}</span>
        </div>
        <p class="dbi-muted">Connections are shared with other projects, so they are not shown here.</p>
      </div>

      <div class="dbi-engine">
        <h3>PostgreSQL connections while this page is open</h3>
        <p class="dbi-muted">Sampled every 30 seconds for up to 30 minutes.</p>
        @if (samples.length >= 2) {
          <svg viewBox="0 0 600 100" role="img" aria-label="PostgreSQL connection trend" class="dbi-trend">
            <polyline [attr.points]="points" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        } @else {
          <p class="dbi-trend-empty" data-testid="dbi-trend-empty">
            {{ samples.length ? 'Collecting samples — the trend appears after the next sample.' : 'No connection samples yet. The trend appears once PostgreSQL reports connections.' }}
          </p>
        }
      </div>
    } @else if (!message) {
      <p class="dbi-empty">No database activity yet. Slow queries and size show here once your app uses its database.</p>
    }
    </div>
  </section>`,
  styles: [`
    :host { display: block; }
    .dbi-body { padding: 1rem 1.25rem; }
    .dbi-controls { display: flex; align-items: center; gap: 0.5rem; }
    .dbi-env select { min-width: 10rem; height: 2rem; padding-top: 0; padding-bottom: 0; }
    .dbi-msg { color: rgb(var(--fg-2)); font-size: 0.8125rem; margin: 0 0 0.75rem; }
    .dbi-muted { color: rgb(var(--fg-3)); font-size: 0.8125rem; margin: 0.25rem 0 0.5rem; }
    .dbi-trend-empty { color: rgb(var(--fg-3)); font-size: 0.8125rem; border: 1px dashed rgb(var(--line-strong)); border-radius: 6px; padding: 1.25rem; text-align: center; margin: 0; }
    .dbi-engine { border-top: 1px solid rgb(var(--line)); padding-top: 1rem; margin-top: 1rem; }
    .dbi-engine-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; }
    .dbi-engine h3 { margin: 0; font-size: 0.875rem; font-weight: 600; }
    .dbi-stat { font-size: 0.8125rem; color: rgb(var(--fg-2)); }
    .dbi-stat b { color: rgb(var(--fg)); font-weight: 600; }
    .dbi-scroll { overflow-x: auto; }
    .dbi-table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
    .dbi-table th { text-align: left; color: rgb(var(--fg-3)); font-weight: 500; padding: 0.375rem 0.5rem; border-bottom: 1px solid rgb(var(--line)); }
    .dbi-table td { padding: 0.375rem 0.5rem; border-bottom: 1px solid rgb(var(--line)); vertical-align: top; }
    .dbi-table code { font-size: 0.78rem; white-space: pre-wrap; word-break: break-word; }
    .dbi-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .dbi-empty { color: rgb(var(--fg-3)); font-size: 0.8125rem; padding: 0.5rem 0; margin: 0; }
    .dbi-trend { max-width: 600px; width: 100%; color: rgb(var(--accent)); }
  `]
})
export class DatabaseInsightsPanelComponent implements OnChanges, OnDestroy {
  @Input() project: any;
  private http = inject(HttpClient);
  environment = 'production'; data: any; message = ''; busy = false;
  samples: number[] = []; private timer?: ReturnType<typeof setInterval>; private generation = 0;
  get points() { const max = Math.max(1, ...this.samples); return this.samples.map((n,i) => `${i * 600 / Math.max(1,this.samples.length-1)},${95-n/max*90}`).join(' '); }
  ngOnChanges() { const envs: string[] = (this.project?.environments || []).map((e: any) => e.name); this.environment = envs.includes('production') ? 'production' : envs[0] || 'production'; this.reset(); if (!this.timer) this.timer = setInterval(() => void this.load(),30000); }
  ngOnDestroy() { this.generation++; if (this.timer) clearInterval(this.timer); }
  reset() { this.generation++; this.busy = false; this.samples = []; this.data = null; void this.load(); }
  bytes(n: unknown): string {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }
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
