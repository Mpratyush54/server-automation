import { Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-database-insights-panel', standalone: true,
  imports: [CommonModule, FormsModule],
  template: `<section class="card dbi" aria-label="Database insights">
    <div class="dbi-head">
      <h2>Database insights</h2>
      <div class="dbi-controls">
        <label class="dbi-env">Environment
          <select [(ngModel)]="environment" (change)="reset()">
            @for (e of project?.environments || []; track e.name) { <option [value]="e.name">{{e.name}}</option> }
          </select>
        </label>
        <button class="btn btn-sm" type="button" (click)="load()" [disabled]="busy">{{ busy ? 'Loading…' : 'Refresh' }}</button>
      </div>
    </div>
    @if (message) { <p class="dbi-msg" role="status">{{message}}</p> }
    @if (data?.enabled) {
      <p class="dbi-muted">Collected {{data.collectedAt | date:'medium'}} · {{environment}}</p>

      <div class="dbi-engine">
        <div class="dbi-engine-head">
          <h3>PostgreSQL</h3>
          <span class="badge" [class.badge-active]="data.postgres.status === 'ready'" [class.badge-pending]="data.postgres.status !== 'ready'">{{data.postgres.status}}</span>
          <span class="dbi-stat">Connections <b>{{data.postgres.connections ?? '—'}}</b></span>
          <span class="dbi-stat">Size <b>{{bytes(data.postgres.sizeBytes)}}</b></span>
        </div>
        <p class="dbi-muted">Top 20 statements by total execution time, cumulative since statistics reset. Literals are never shown.</p>
        @if ((data.postgres.topQueries || []).length) {
          <div class="dbi-scroll"><table class="dbi-table"><thead><tr><th>Query shape</th><th class="num">Calls</th><th class="num">Rows</th><th class="num">Mean ms</th><th class="num">Total ms</th></tr></thead><tbody>
          @for (q of data.postgres.topQueries; track $index) { <tr><td><code>{{q.query}}</code></td><td class="num">{{q.calls}}</td><td class="num">{{q.rows}}</td><td class="num">{{q.latencyMs | number:'1.1-2'}}</td><td class="num">{{q.totalMs | number:'1.1-2'}}</td></tr> }
          </tbody></table></div>
        } @else { <p class="dbi-empty">No statements recorded for this environment yet.</p> }
      </div>

      <div class="dbi-engine">
        <div class="dbi-engine-head">
          <h3>MongoDB</h3>
          <span class="badge" [class.badge-active]="data.mongo.status === 'ready'" [class.badge-pending]="data.mongo.status !== 'ready'">{{data.mongo.status}}</span>
          <span class="dbi-stat">Size <b>{{bytes(data.mongo.sizeBytes)}}</b></span>
        </div>
        <p class="dbi-muted">Slow operations ≥ {{data.slowMs}} ms in the last hour.</p>
        @if ((data.mongo.slowQueries || []).length) {
          <div class="dbi-scroll"><table class="dbi-table"><thead><tr><th>Operation shape</th><th>Time</th><th class="num">Latency ms</th><th class="num">Rows</th></tr></thead><tbody>
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
        <p class="dbi-muted">Connections are shared across projects and cannot be attributed reliably.</p>
      </div>

      <div class="dbi-engine">
        <h3>PostgreSQL connections during this visit</h3>
        <p class="dbi-muted">30-second samples, up to 30 minutes. Switching environments clears samples.</p>
        <svg viewBox="0 0 600 100" role="img" aria-label="PostgreSQL connection trend" class="dbi-trend">
          <polyline [attr.points]="points" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
      </div>
    }
  </section>`,
  styles: [`
    .dbi { padding: 24px; }
    .dbi-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 8px; }
    .dbi-head h2 { margin: 0; font-size: 1.1rem; }
    .dbi-controls { display: flex; align-items: flex-end; gap: 8px; }
    .dbi-env { display: flex; flex-direction: column; gap: 4px; font-size: 0.8rem; color: var(--text-secondary); }
    .dbi-env select { min-width: 160px; }
    .dbi-msg { color: var(--text-secondary); }
    .dbi-muted { color: var(--text-muted); font-size: 0.82rem; margin: 4px 0 8px; }
    .dbi-engine { border-top: 1px solid #222; padding-top: 16px; margin-top: 16px; }
    .dbi-engine-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .dbi-engine h3 { margin: 0; font-size: 0.95rem; }
    .dbi-stat { font-size: 0.82rem; color: var(--text-secondary); }
    .dbi-stat b { color: var(--text-primary); font-weight: 600; }
    .dbi-scroll { overflow-x: auto; }
    .dbi-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    .dbi-table th { text-align: left; color: var(--text-muted); font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #222; }
    .dbi-table td { padding: 6px 8px; border-bottom: 1px solid #1a1a1a; vertical-align: top; }
    .dbi-table code { font-family: var(--font-code); font-size: 0.78rem; white-space: pre-wrap; word-break: break-word; }
    .dbi-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .dbi-empty { color: var(--text-muted); font-size: 0.85rem; padding: 8px 0; }
    .dbi-trend { max-width: 600px; width: 100%; color: var(--accent-success); }
  `],
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
