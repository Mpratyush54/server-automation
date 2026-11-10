import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-errors', standalone: true, imports: [CommonModule, FormsModule, RouterModule],
  styles: [`:host{display:block;padding:24px}label{display:inline-block;margin:8px}input,select,button{padding:8px;margin:4px}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #8885}pre{white-space:pre-wrap;overflow-wrap:anywhere}button,a{cursor:pointer}.regression{color:#e55353}`],
  template: `
    <h1>Errors</h1>
    <p>Group exceptions by environment and release, inspect original stack frames, and triage regressions.</p>
    <p *ngIf="error" role="alert">{{error}}</p>
    <label>Project <select [(ngModel)]="project" (change)="offset=0; load()"><option value="">Choose project</option><option *ngFor="let p of projects" [value]="p.id">{{p.name}}</option></select></label>
    <label>Release <input [(ngModel)]="release" placeholder="All releases"></label>
    <label>Environment <input [(ngModel)]="environment" placeholder="All environments"></label>
    <label>Status <select [(ngModel)]="status"><option value="">All</option><option>open</option><option>resolved</option><option>ignored</option></select></label>
    <button (click)="offset=0; load()" [disabled]="busy || !project">Filter</button>
    <p *ngIf="busy">Loading…</p>
    <table><thead><tr><th>Issue</th><th>Status</th><th>Events</th><th>Last seen</th></tr></thead><tbody>
    <tr *ngFor="let i of issues"><td><button (click)="open(i.id)">{{i.title}}</button><span class="regression" *ngIf="i.regression"> Regression</span><br>{{i.environment}} · {{i.latest_release}}</td><td>{{i.status}}</td><td>{{i.count}}</td><td>{{i.last_seen | date:'medium'}}</td></tr>
    </tbody></table><p *ngIf="!busy && !issues.length">No issues for these filters.</p>
    <button (click)="page(-1)" [disabled]="offset === 0">Previous</button><button (click)="page(1)" [disabled]="issues.length < 50">Next</button>
    <section *ngIf="detail"><h2>{{detail.issue.title}}</h2>
      <p>First seen {{detail.issue.first_seen | date:'medium'}} · Last seen {{detail.issue.last_seen | date:'medium'}}</p>
      <p>Counts per release: {{detail.issue.release_counts | json}}</p>
      <label>Assignee <select [(ngModel)]="assignee"><option value="">Unassigned</option><option *ngFor="let m of members" [value]="m.userId || m.user_id">{{m.user?.name || m.user?.email || m.userId || m.user_id}}</option></select></label><button (click)="triage(undefined)">Assign</button>
      <button (click)="triage('open')">Reopen</button><button (click)="triage('resolved')">Resolve</button><button (click)="triage('ignored')">Ignore</button>
      <article *ngFor="let e of detail.events"><h3>{{e.payload.type}} · {{e.payload.release}}</h3><p>{{e.payload.message}}</p><p>{{e.received_at | date:'medium'}} · Session {{e.payload.sessionId || '—'}} · User {{e.payload.userId || '—'}}</p>
      <a *ngIf="e.payload.traceId" [href]="traceUrl(e.payload.traceId)">Trace {{e.payload.traceId}}</a>
      <a *ngIf="e.payload.replayId" [routerLink]="['/projects', project, 'replays', e.payload.replayId]">Replay {{e.payload.replayId}}</a>
      <h4>Original stack</h4><pre *ngFor="let f of e.symbolicated">{{f.function || '(anonymous)'}} at {{f.file}}:{{f.line}}:{{f.column}}</pre>
      <details><summary>Raw stack</summary><pre>{{e.payload.frames | json}}</pre></details>
      <h4>Breadcrumbs</h4><pre>{{e.payload.breadcrumbs || [] | json}}</pre></article>
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
    if (!this.project) return;
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
