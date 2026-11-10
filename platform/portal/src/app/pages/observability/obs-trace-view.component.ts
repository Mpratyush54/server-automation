import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { buildWaterfall, fmtMs, projectBase, Span, WaterfallRow } from './observability-api';

/** Trace waterfall (#48): spans of this project only; others are counted as hidden. */
@Component({
  selector: 'app-obs-trace-view',
  standalone: true,
  imports: [CommonModule],
  styleUrls: ['./obs-theme.css'],
  styles: [`
    .wf { font-size: 0.8rem; }
    .wf-row { display: grid; grid-template-columns: minmax(180px, 34%) 1fr 70px; gap: 8px; align-items: center; padding: 3px 4px; cursor: pointer; border-radius: 4px; }
    .wf-row:hover, .wf-row.selected { background: var(--obs-hover); }
    .wf-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wf-svc { color: var(--obs-muted); margin-right: 4px; }
    .wf-track { position: relative; height: 12px; background: var(--obs-elevated); border-radius: 2px; }
    .wf-bar { position: absolute; top: 0; bottom: 0; background: var(--obs-series-1); border-radius: 2px; min-width: 2px; }
    .wf-bar.error { background: var(--obs-bad); }
    .detail { margin-top: 12px; }
    .attrs { display: grid; grid-template-columns: minmax(140px, 30%) 1fr; gap: 2px 12px; font-size: 0.8rem; }
    .attrs div:nth-child(odd) { color: var(--obs-muted); overflow-wrap: anywhere; }
    .attrs div:nth-child(even) { overflow-wrap: anywhere; font-family: var(--font-code, monospace); }
  `],
  template: `
    @if (loading) { <div class="obs-empty">Loading trace…</div> }
    @if (error) { <div class="obs-banner error" role="alert">{{ error }}</div> }
    @if (!loading && rows.length) {
      <div class="obs-row" style="justify-content:space-between;margin-bottom:8px">
        <div><strong>Trace</strong> <span class="obs-code">{{ traceId }}</span> · {{ ms(durationMs) }} · {{ rows.length }} spans
          @if (hiddenSpans) { <span class="obs-faint"> · {{ hiddenSpans }} spans from other projects hidden</span> }
          @if (truncated) { <span class="obs-warn"> · truncated</span> }
        </div>
        <div class="obs-links">
          <button class="obs-btn" (click)="logsForTrace.emit(traceId)">Logs for this trace</button>
          <button class="obs-btn" (click)="closed.emit()">Close</button>
        </div>
      </div>
      <div class="wf" role="list" aria-label="Trace waterfall">
        @for (r of rows; track r.span.spanId) {
          <div class="wf-row" role="listitem" [class.selected]="selected?.spanId === r.span.spanId" (click)="select(r.span)">
            <div class="wf-name" [style.padding-left.px]="r.depth * 14" [title]="r.span.serviceName + ' ' + r.span.name">
              <span class="wf-svc">{{ r.span.serviceName }}</span>{{ r.span.name }}
            </div>
            <div class="wf-track"><div class="wf-bar" [class.error]="r.error" [style.left.%]="r.offset" [style.width.%]="r.width"></div></div>
            <div class="obs-num">{{ ms(r.span.durationMs) }}</div>
          </div>
        }
      </div>
      @if (selected) {
        <div class="detail obs-card">
          <h3>{{ selected.name }} <span class="obs-faint">({{ selected.kind }}, {{ selected.status.code }})</span></h3>
          @if (selected.status.message) { <p class="obs-bad">{{ selected.status.message }}</p> }
          <div class="attrs">
            <div>service</div><div>{{ selected.serviceName }}</div>
            <div>span id</div><div>{{ selected.spanId }}</div>
            <div>duration</div><div>{{ ms(selected.durationMs) }}</div>
            @for (a of entries(selected.attributes); track a[0]) { <div>{{ a[0] }}</div><div>{{ a[1] }}</div> }
          </div>
          @if (selected.events?.length) {
            <h3 style="margin-top:12px">Events</h3>
            @for (e of selected.events; track $index) { <div><strong>{{ e.name }}</strong> <span class="obs-faint">{{ entries(e.attributes).length }} attributes</span></div> }
          }
        </div>
      }
    }
  `,
})
export class ObsTraceViewComponent implements OnChanges {
  private http = inject(HttpClient);

  @Input() projectId = '';
  @Input() traceId = '';
  @Output() closed = new EventEmitter<void>();
  @Output() logsForTrace = new EventEmitter<string>();

  rows: WaterfallRow[] = [];
  durationMs = 0;
  hiddenSpans = 0;
  truncated = false;
  selected: Span | null = null;
  loading = false;
  error = '';
  readonly ms = fmtMs;

  ngOnChanges(changes: SimpleChanges): void {
    if ((changes['traceId'] || changes['projectId']) && this.projectId && this.traceId) void this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    this.rows = [];
    this.selected = null;
    try {
      const res: any = await firstValueFrom(this.http.get(`${projectBase(this.projectId)}/traces/${encodeURIComponent(this.traceId)}`));
      const wf = buildWaterfall(res.spans || []);
      this.rows = wf.rows;
      this.durationMs = wf.durationMs;
      this.hiddenSpans = res.hiddenSpans || 0;
      this.truncated = !!res.truncated;
      this.selected = this.rows[0]?.span || null;
    } catch (e: any) {
      this.error = e?.status === 404 ? 'Trace not found in this project (it may have expired).' : e?.error?.error || 'Could not load the trace.';
    } finally {
      this.loading = false;
    }
  }

  select(s: Span) {
    this.selected = s;
  }

  entries(o: Record<string, unknown> | undefined): Array<[string, string]> {
    return Object.entries(o || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
  }
}
