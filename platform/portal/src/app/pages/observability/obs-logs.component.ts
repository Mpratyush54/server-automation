import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { nsToDate, projectBase } from './observability-api';

export interface LogEntry { ts: string; line: string; labels: Record<string, string>; traceId: string | null; spanId: string | null }

/**
 * Logs explorer (#48): structured filters or LogQL (scoped server-side), live
 * tail by polling with a nanosecond cursor, and trace links.
 */
@Component({
  selector: 'app-obs-logs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrls: ['./obs-theme.css'],
  styles: [`
    .lines { font-family: var(--font-code, ui-monospace, monospace); font-size: 0.78rem; max-height: 560px; overflow: auto; border: 1px solid var(--obs-border); border-radius: 6px; }
    .line { display: grid; grid-template-columns: 160px 1fr auto; gap: 8px; padding: 3px 8px; border-bottom: 1px solid var(--obs-border); }
    .line:hover { background: var(--obs-hover); }
    .ts { color: var(--obs-muted); white-space: nowrap; }
    .msg { white-space: pre-wrap; overflow-wrap: anywhere; }
    .lvl-error .msg { color: var(--obs-bad); }
    .lvl-warn .msg { color: var(--obs-warn); }
    .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 8px; }
    .filters label { display: flex; flex-direction: column; gap: 4px; font-size: 0.78rem; color: var(--obs-muted); }
    textarea { width: 100%; min-height: 54px; box-sizing: border-box; }
  `],
  template: `
    <div class="obs-row" style="margin-bottom:8px">
      <label><input type="radio" name="logmode" value="filters" [(ngModel)]="mode"> Filters</label>
      <label><input type="radio" name="logmode" value="logql" [(ngModel)]="mode"> LogQL</label>
      <span class="obs-faint">Queries are always limited to this project.</span>
    </div>
    @if (mode === 'filters') {
      <div class="filters">
        <label>Service <input class="obs-input" [(ngModel)]="service" placeholder="any"></label>
        <label>Level <select class="obs-select" [(ngModel)]="level"><option value="">any</option><option>error</option><option>warn</option><option>info</option><option>debug</option></select></label>
        <label>Contains <input class="obs-input" [(ngModel)]="search" placeholder="text"></label>
        <label>Trace id <input class="obs-input code" [(ngModel)]="traceIdFilter" placeholder="32 hex chars"></label>
      </div>
    } @else {
      <textarea class="obs-input" [(ngModel)]="query" aria-label="LogQL query" placeholder='{service_name="api"} |= "error"'></textarea>
    }
    <div class="obs-row" style="margin:8px 0">
      <button class="obs-btn primary" (click)="run()" [disabled]="loading">Run</button>
      <label class="obs-row" style="gap:4px"><input type="checkbox" [(ngModel)]="live" (ngModelChange)="toggleLive()"> Live tail</label>
      @if (truncated) { <span class="obs-faint">Showing the newest {{ entries.length }} lines</span> }
    </div>
    @if (error) { <div class="obs-banner error" role="alert">{{ error }}</div> }
    @if (metricResult) {
      <div class="obs-banner">This LogQL is a metric query ({{ metricResult.length }} series). Use the APM or Overview tabs for charts.</div>
    }
    @if (!loading && !entries.length && !error && ran && !metricResult) {
      <div class="obs-empty"><strong>No log lines</strong>Nothing matched in this time range.</div>
    }
    @if (entries.length) {
      <div class="lines" role="log" aria-label="Log lines">
        @for (e of entries; track e.ts + $index) {
          <div class="line" [class]="'line lvl-' + levelOf(e)">
            <span class="ts">{{ time(e.ts) | date: 'MMM d, HH:mm:ss.SSS' }}</span>
            <span class="msg"><span class="obs-faint">{{ e.labels['service_name'] || '' }}</span> {{ e.line }}</span>
            <span>@if (e.traceId) { <button class="obs-btn" style="padding:0 6px" (click)="openTrace.emit(e.traceId)" [title]="'Open trace ' + e.traceId">Trace</button> }</span>
          </div>
        }
      </div>
    }
  `,
})
export class ObsLogsComponent implements OnChanges, OnDestroy {
  private http = inject(HttpClient);

  @Input() projectId = '';
  @Input() since = '1h';
  @Input() environment = '';
  /** Pre-filter by trace id (log ↔ trace navigation). */
  @Input() traceId = '';
  @Input() initialQuery = '';
  @Output() openTrace = new EventEmitter<string>();
  @Output() queryChange = new EventEmitter<string>();

  mode: 'filters' | 'logql' = 'filters';
  query = '';
  service = '';
  level = '';
  search = '';
  traceIdFilter = '';
  entries: LogEntry[] = [];
  metricResult: any[] | null = null;
  truncated = false;
  loading = false;
  ran = false;
  error = '';
  live = false;
  private timer: any;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['initialQuery'] && this.initialQuery) { this.mode = 'logql'; this.query = this.initialQuery; }
    if (changes['traceId'] && this.traceId) { this.mode = 'filters'; this.traceIdFilter = this.traceId; }
    if (this.projectId) void this.run();
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  params(): Record<string, string> {
    const p: Record<string, string> = { since: this.since, limit: '300' };
    if (this.mode === 'logql') {
      p['query'] = this.query.trim();
    } else {
      if (this.service.trim()) p['service'] = this.service.trim();
      if (this.environment) p['environment'] = this.environment;
      if (this.level) p['level'] = this.level;
      if (this.search.trim()) p['search'] = this.search.trim();
      if (this.traceIdFilter.trim()) p['traceId'] = this.traceIdFilter.trim();
    }
    return p;
  }

  async run() {
    if (this.mode === 'logql' && !this.query.trim()) { this.error = 'Enter a LogQL query.'; return; }
    this.loading = true;
    this.error = '';
    this.metricResult = null;
    if (this.mode === 'logql') this.queryChange.emit(this.query.trim());
    try {
      const res: any = await firstValueFrom(this.http.get(`${projectBase(this.projectId)}/query/loki`, { params: this.params() }));
      if (res.resultType && res.resultType !== 'streams') {
        this.metricResult = res.result || [];
        this.entries = [];
      } else {
        this.entries = res.entries || [];
        this.truncated = !!res.truncated;
      }
    } catch (e: any) {
      this.error = e?.error?.error || 'Log query failed.';
      this.entries = [];
    } finally {
      this.loading = false;
      this.ran = true;
    }
  }

  toggleLive() {
    clearInterval(this.timer);
    if (this.live) this.timer = setInterval(() => void this.tail(), 5000);
  }

  /** Fetch entries newer than the newest one shown and prepend them. */
  async tail() {
    if (this.loading) return;
    const newest = this.entries[0]?.ts;
    const params = { ...this.params(), since: '5m', direction: 'forward', ...(newest ? { after: newest } : {}) };
    try {
      const res: any = await firstValueFrom(this.http.get(`${projectBase(this.projectId)}/query/loki`, { params }));
      const fresh: LogEntry[] = res.entries || [];
      if (fresh.length) this.entries = [...fresh, ...this.entries].slice(0, 1000);
    } catch (e: any) {
      this.error = e?.error?.error || 'Live tail stopped: query failed.';
      this.live = false;
      clearInterval(this.timer);
    }
  }

  time(ts: string): Date | null {
    return nsToDate(ts);
  }

  levelOf(e: LogEntry): string {
    const l = (e.labels['severity_text'] || e.labels['detected_level'] || e.labels['level'] || '').toLowerCase();
    if (l.startsWith('err') || l === 'fatal' || l === 'critical') return 'error';
    if (l.startsWith('warn')) return 'warn';
    return 'info';
  }
}
