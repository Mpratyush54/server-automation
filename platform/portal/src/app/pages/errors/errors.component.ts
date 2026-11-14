import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-errors', standalone: true, imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './errors.component.html',
  styleUrl: './errors.component.css',
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
