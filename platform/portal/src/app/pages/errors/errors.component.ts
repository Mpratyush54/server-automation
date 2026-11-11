import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-errors', standalone: true, imports: [CommonModule, FormsModule, RouterModule],
  styles: [`
    :host { display: block; }
    .filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: end; }
    .filters .form-group { margin: 0; }
    .issue-link { background: none; border: 0; padding: 0; color: #ededed; font-weight: 500; text-align: left; cursor: pointer; }
    .issue-link:hover { text-decoration: underline; }
    .issue-meta { font-size: 0.75rem; color: #a1a1aa; margin-top: 2px; }
    .regression { color: #f87171; font-size: 0.75rem; margin-left: 6px; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .pager { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    .meta { color: #a1a1aa; font-size: 0.85rem; margin: 0 0 4px; }
    .triage { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin: 16px 0; }
    .triage .form-group { margin: 0; min-width: 200px; }
    .event { border-top: 1px solid #222; padding-top: 16px; margin-top: 16px; }
    .event h3 { font-size: 0.95rem; font-weight: 600; margin: 0 0 4px; }
    .event h4 { font-size: 0.8rem; font-weight: 500; color: #a1a1aa; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; }
    .event-links { display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.85rem; }
    .event-links a { color: #60a5fa; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-code); font-size: 0.8rem; background: #111; border: 1px solid #222; border-radius: 6px; padding: 8px 10px; margin: 4px 0; }
    details summary { cursor: pointer; color: #a1a1aa; font-size: 0.85rem; margin-top: 8px; }
    .banner-error { border-color: #7f1d1d; color: #fca5a5; margin-bottom: 16px; }
  `],
  template: `
    <div class="page-header">
      <div>
        <h1 class="page-title">Errors</h1>
        <p class="page-subtitle">Group exceptions by environment and release, inspect original stack frames, and triage regressions.</p>
      </div>
    </div>
    <div *ngIf="error" class="card banner-error" role="alert">{{error}}</div>

    <div class="card mb-4">
      <div class="filters">
        <div class="form-group"><label for="err-project">Project</label>
          <select id="err-project" [(ngModel)]="project" (change)="offset=0; load()" data-testid="errors-project"><option value="">Choose project</option><option *ngFor="let p of projects" [value]="p.id">{{p.name}}</option></select></div>
        <div class="form-group"><label for="err-release">Release</label><input id="err-release" [(ngModel)]="release" placeholder="All releases" [disabled]="!project"></div>
        <div class="form-group"><label for="err-env">Environment</label><input id="err-env" [(ngModel)]="environment" placeholder="All environments" [disabled]="!project"></div>
        <div class="form-group"><label for="err-status">Status</label>
          <select id="err-status" [(ngModel)]="status" [disabled]="!project"><option value="">All</option><option>open</option><option>resolved</option><option>ignored</option></select></div>
        <div><button class="btn btn-primary w-full" (click)="offset=0; load()" [disabled]="busy || !project">Filter</button></div>
      </div>
    </div>

    <div *ngIf="!project" class="card empty-state" data-testid="errors-choose-project">
      <strong>Choose a project</strong>
      Error issues are grouped per project. Select one above to see its issues.
    </div>

    <div *ngIf="project" class="card mb-4">
      <div class="table-scroll">
        <table>
          <thead><tr><th>Issue</th><th>Status</th><th class="num">Events</th><th>Last seen</th></tr></thead>
          <tbody>
            <tr *ngFor="let i of issues">
              <td><button class="issue-link" (click)="open(i.id)">{{i.title}}</button><span class="regression" *ngIf="i.regression">Regression</span>
                <div class="issue-meta">{{i.environment}} · {{i.latest_release}}</div></td>
              <td><span class="badge" [class.badge-failed]="i.status === 'open'" [class.badge-active]="i.status === 'resolved'" [class.badge-pending]="i.status === 'ignored'">{{i.status}}</span></td>
              <td class="num">{{i.count}}</td>
              <td class="whitespace-nowrap">{{i.last_seen | date:'medium'}}</td>
            </tr>
            <tr *ngIf="busy" class="empty-row"><td colspan="4">Loading…</td></tr>
            <tr *ngIf="!busy && !issues.length" class="empty-row" data-testid="errors-empty"><td colspan="4">No issues for these filters.</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <button class="btn btn-sm" (click)="page(-1)" [disabled]="offset === 0">Previous</button>
        <button class="btn btn-sm" (click)="page(1)" [disabled]="issues.length < 50">Next</button>
      </div>
    </div>

    <section *ngIf="detail" class="card" data-testid="error-detail">
      <h2>{{detail.issue.title}}</h2>
      <p class="meta">First seen {{detail.issue.first_seen | date:'medium'}} · Last seen {{detail.issue.last_seen | date:'medium'}}</p>
      <p class="meta">Counts per release:
        <ng-container *ngFor="let rc of (detail.issue.release_counts || {}) | keyvalue; let last = last">{{rc.key}}: {{rc.value}}<ng-container *ngIf="!last">, </ng-container></ng-container>
        <ng-container *ngIf="!(detail.issue.release_counts | keyvalue)?.length">—</ng-container>
      </p>
      <div class="triage">
        <div class="form-group"><label for="err-assignee">Assignee</label>
          <select id="err-assignee" [(ngModel)]="assignee"><option value="">Unassigned</option><option *ngFor="let m of members" [value]="m.userId || m.user_id">{{m.user?.name || m.user?.email || m.userId || m.user_id}}</option></select></div>
        <button class="btn" (click)="triage(undefined)">Assign</button>
        <button class="btn" (click)="triage('open')">Reopen</button>
        <button class="btn" (click)="triage('resolved')">Resolve</button>
        <button class="btn" (click)="triage('ignored')">Ignore</button>
      </div>

      <div *ngIf="!detail.events?.length" class="empty-state" data-testid="error-detail-no-events">
        <strong>No stored events for this issue</strong>
        Events may have expired under the retention policy.
      </div>

      <article class="event" *ngFor="let e of detail.events">
        <h3>{{e.payload.type}} · {{e.payload.release}}</h3>
        <p>{{e.payload.message}}</p>
        <p class="meta">{{e.received_at | date:'medium'}} · Session {{e.payload.sessionId || '—'}} · User {{e.payload.userId || '—'}}</p>
        <div class="event-links">
          <a *ngIf="e.payload.traceId" [href]="traceUrl(e.payload.traceId)">Trace {{e.payload.traceId}}</a>
          <a *ngIf="e.payload.replayId" [routerLink]="['/projects', project, 'replays', e.payload.replayId]">Replay {{e.payload.replayId}}</a>
        </div>
        <h4>Original stack</h4><pre *ngFor="let f of e.symbolicated">{{f.function || '(anonymous)'}} at {{f.file}}:{{f.line}}:{{f.column}}</pre>
        <details><summary>Raw stack</summary><pre>{{e.payload.frames | json}}</pre></details>
        <h4>Breadcrumbs</h4><pre>{{e.payload.breadcrumbs || [] | json}}</pre>
      </article>
    </section>`,
})
export class ErrorsComponent implements OnInit {
  project = ''; release = ''; environment = ''; status = ''; offset = 0;
  projects: any[] = []; issues: any[] = []; members: any[] = []; detail: any; assignee = ''; error = ''; busy = false;
  constructor(private http: HttpClient, private route: ActivatedRoute) {}
  async ngOnInit() {
    this.project = this.route.snapshot.paramMap.get('id') || '';
    try { this.projects = await firstValueFrom(this.http.get<any[]>('/api/projects')); await this.load();
      const issue = this.route.snapshot.queryParamMap.get('issue'); if (issue && this.project) await this.open(issue);
    } catch { this.error = 'Could not load projects.'; }
  }
  traceUrl(id: string) {
    return '/grafana/explore?left=' + encodeURIComponent(JSON.stringify({ datasource: 'Tempo', queries: [{ refId: 'A', queryType: 'traceId', query: id }], range: { from: 'now-24h', to: 'now' } }));
  }
  base() { return '/api/projects/' + encodeURIComponent(this.project); }
  async load() {
    if (!this.project) { this.issues = []; this.detail = null; return; }
    this.busy = true; this.error = ''; this.detail = null;
    try { this.issues = await firstValueFrom(this.http.get<any[]>(this.base() + '/errors', { params: { release: this.release, environment: this.environment, status: this.status, offset: this.offset } })); }
    catch { this.error = 'Could not load errors.'; } finally { this.busy = false; }
  }
  page(direction: number) { this.offset = Math.max(0, this.offset + direction * 50); void this.load(); }
  async open(id: string) {
    try {
      this.detail = await firstValueFrom(this.http.get<any>(this.base() + '/errors/' + id, { params: { release: this.release } }));
      this.assignee = this.detail.issue.assignee_id || '';
      const response: any = await firstValueFrom(this.http.get(this.base() + '/members'));
      this.members = Array.isArray(response) ? response : response.members || [];
    } catch { this.error = 'Could not load issue or project members.'; }
  }
  async triage(status?: string) {
    try {
      const id = this.detail.issue.id;
      await firstValueFrom(this.http.patch(this.base() + '/errors/' + id, { status, assigneeId: this.assignee || null }));
      await this.load(); await this.open(id);
    } catch { this.error = 'Could not save triage. Project developer access is required.'; }
  }
}
