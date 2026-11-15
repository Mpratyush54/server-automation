import { Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { OperationProgressComponent } from '../../shared/operation-progress.component';
@Component({
  selector: 'app-releases-panel', standalone: true,
  imports: [CommonModule, FormsModule, OperationProgressComponent],
  template: `
    <section class="card card-flush" aria-label="Release tracking">
      <div class="card-header"><h2>Before and after a deployment</h2></div>
      <div class="rp-body">
      <p class="rp-hint">See whether a deployment made errors or response times worse. <a href="https://platform.pratyushes.dev/docs/observability/releases" target="_blank" rel="noopener">Learn more</a></p>
      @if (message) { <p class="rp-msg" role="status">{{message}}</p> }
      <div class="rp-controls">
        <div class="form-group"><label for="rp-release">Deployment</label>
          <select id="rp-release" [(ngModel)]="selected" (change)="compare()">
            <option value="">Select a deployment</option>
            @for (r of releases; track r.id) { <option [value]="r.id">{{r.release}} · {{r.markerAt | date:'short'}} · {{r.status}}</option> }
          </select></div>
        <div class="form-group rp-minutes"><label for="rp-minutes">Minutes to compare</label>
          <input id="rp-minutes" type="number" min="1" max="120" [(ngModel)]="minutes" (change)="compare()"></div>
        <button class="btn btn-ghost" (click)="load()" [disabled]="busy">Refresh</button>
      </div>
      @if (!releases.length && !message) { <div class="empty-state">Nothing to compare yet. After your first successful deployment, its effect on errors and speed shows here.</div> }
      @if (comparison; as c) {
        <p class="rp-hint">{{c.release}} · {{c.complete ? 'Comparison complete' : 'Still collecting data after the deployment'}}</p>
        <svg viewBox="0 0 600 180" role="img" aria-label="p95 latency before and after deployment" class="rp-chart">
          <line x1="300" x2="300" y1="10" y2="150" stroke="currentColor" stroke-dasharray="4" />
          <text x="305" y="20" fill="currentColor">Deploy marker</text>
          <rect x="100" [attr.y]="150-bar(c.before.p95LatencyMs)" width="100" [attr.height]="bar(c.before.p95LatencyMs)" class="rp-before" />
          <rect x="400" [attr.y]="150-bar(c.after.p95LatencyMs)" width="100" [attr.height]="bar(c.after.p95LatencyMs)" class="rp-after" />
          <text x="100" y="175" fill="currentColor">Before p95</text><text x="400" y="175" fill="currentColor">After p95</text>
        </svg>
        <div class="table-scroll">
          <table><thead><tr><th>Metric</th><th class="num">Before</th><th class="num">After</th><th class="num">Delta</th><th class="num">Change %</th></tr></thead><tbody>
            @for (m of metrics; track m.key) {
              <tr><td>{{m.label}}</td><td class="num">{{value(c.before[m.key])}}</td><td class="num">{{value(c.after[m.key])}}</td><td class="num">{{value(c.deltas[m.key].absolute)}}</td><td class="num">{{value(c.deltas[m.key].percent)}}</td></tr>
            }
          </tbody></table>
        </div>
        <p class="rp-hint">Page speed in browsers: {{c.webVitalsUnavailable}}</p>
        <details class="rp-advanced">
        <summary>Roll back this deployment</summary>
        <div class="rp-controls">
          <div class="form-group rp-reason"><label for="rp-reason">Rollback reason</label>
            <input id="rp-reason" [(ngModel)]="reason" maxlength="1000" placeholder="Why are you rolling back?"></div>
          <button class="btn btn-danger" (click)="rollback()" [disabled]="busy || !reason.trim()">Roll back to previous release</button>
        </div>
        </details>
      }
      @if (operationId) { <app-operation-progress [operationId]="operationId" /> }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rp-body { padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .rp-hint, .rp-msg { color: rgb(var(--fg-2)); font-size: 0.8125rem; margin: 0; }
    .rp-controls { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; }
    .rp-controls .form-group { margin: 0; flex: 1 1 240px; }
    .rp-controls .rp-minutes { flex: 0 1 180px; }
    .rp-controls .rp-reason { flex: 1 1 320px; }
    .rp-chart { width: 100%; max-width: 600px; color: rgb(var(--fg-3)); font-size: 12px; }
    .rp-before { fill: rgb(var(--fg-3)); }
    .rp-after { fill: rgb(var(--accent)); }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .rp-advanced { border-top: 1px solid rgb(var(--line)); padding-top: 0.75rem; }
    .rp-advanced > summary { cursor: pointer; font-size: 0.8125rem; color: rgb(var(--fg-2)); width: fit-content; }
    .rp-advanced[open] > summary { margin-bottom: 0.75rem; }
  `]
})
export class ReleasesPanelComponent implements OnChanges, OnDestroy {
  @Input() projectId = '';
  private http = inject(HttpClient);
  releases: any[] = []; selected = ''; minutes = 15; reason = ''; comparison: any;
  message = ''; busy = false; operationId: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  metrics = [{key:'errorRate',label:'Error rate (%)'}, {key:'p95LatencyMs',label:'p95 latency (ms)'}, {key:'throughputRps',label:'Requests / second'}, {key:'newErrorIssues',label:'New error issues'}];
  ngOnChanges() { if (this.projectId) { this.selected = ''; this.comparison = null; void this.load(); if (!this.timer) this.timer = setInterval(() => void this.load(), 30000); } }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }
  async load() {
    try { this.releases = await firstValueFrom(this.http.get<any[]>(`/api/projects/${this.projectId}/releases`));
      if (!this.selected && this.releases.length) this.selected = this.releases[0].id;
      await this.compare();
    } catch (e: any) { this.message = e.error?.error || 'Could not load deployments. Try Refresh.'; }
  }
  async compare() {
    if (!this.selected) return;
    try { this.comparison = await firstValueFrom(this.http.get(`/api/projects/${this.projectId}/releases/${this.selected}/comparison`, { params: { minutes: this.minutes } })); this.message = ''; }
    catch (e: any) { this.comparison = null; this.message = e.error?.error || 'No comparison for this deployment yet.'; }
  }
  value(v: number | null) { return v == null ? 'No data' : v.toFixed(2); }
  bar(v: number | null) { return v == null ? 0 : 110 * v / Math.max(1, this.comparison?.before.p95LatencyMs || 0, this.comparison?.after.p95LatencyMs || 0); }
  async rollback() {
    if (this.busy || !this.reason.trim()) return;
    this.busy = true;
    try {
      const result = await firstValueFrom(this.http.post<any>('/api/rollback', { deploymentId: this.selected, reason: this.reason.trim() }, { headers: { 'Idempotency-Key': crypto.randomUUID() } }));
      this.operationId = result.operationId; this.message = 'Rolling back. It shows in the list once it finishes.';
    } catch (e: any) { this.message = e.error?.error || 'Rollback did not start. Try again.'; }
    finally { this.busy = false; }
  }
}
