import { Component, EventEmitter, Input, Output, SimpleChanges, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-argocd-panel', standalone: true,
  template: `
    <section class="card" aria-label="ArgoCD application" style="margin-top:20px; padding:20px">
      <h2>GitOps / ArgoCD</h2>
      <label>Environment
        <select aria-label="ArgoCD environment" [value]="environment" (change)="selectEnvironment($any($event.target).value)" [disabled]="!!busy || loading">
          @for (env of project?.environments || []; track env.id) { <option [value]="env.name">{{ env.name }}</option> }
        </select>
      </label>
      <p>Sync: <strong>{{ view?.syncStatus || 'Unknown' }}</strong> | Health: <strong>{{ view?.healthStatus || 'Unknown' }}</strong></p>
      <p>Branch / target: <code>{{ view?.branch || project?.gitRevision || project?.defaultBranch || 'HEAD' }}</code></p>
      <p>Revision: <code>{{ view?.sync?.revision || view?.revision || 'Unknown' }}</code></p>
      @if (view?.resources) {
        <p>{{ view.resources.synced }} / {{ view.resources.total }} resources synced | {{ view.resources.degraded }} degraded</p>
      }
      @if (view?.conditions?.length || view?.operationState?.message) {
        <div role="alert" class="argo-alert">
          @for (condition of view?.conditions || []; track $index) {
            <p><strong>{{ condition.type }}:</strong> <span class="verbatim">{{ condition.message }}</span></p>
          }
          @if (view?.operationState?.message) {
            <p><strong>{{ view.operationState.phase }}:</strong> <span class="verbatim">{{ view.operationState.message }}</span></p>
          }
        </div>
      }
      @if (view?.error) { <p role="alert" class="argo-alert">{{ view.error }}</p> }
      @if (loading) { <p role="status">Loading ArgoCD status...</p> }
      @if (error) { <p role="alert" class="argo-alert">{{ error }}</p> }
      @if (notice) { <p role="status">{{ notice }}</p> }
      <div style="display:flex; gap:12px; flex-wrap:wrap">
        <button class="btn btn-sm" (click)="act('refresh')" [disabled]="!!busy || loading || !view?.connected">{{ busy === 'refresh' ? 'Refreshing...' : 'Refresh' }}</button>
        <button class="btn btn-sm btn-primary" (click)="act('sync')" [disabled]="!!busy || loading || !view?.connected || view?.operationState?.phase === 'Running' || view?.operationState?.phase === 'Terminating'">{{ busy === 'sync' ? 'Requesting sync...' : 'Sync' }}</button>
      </div>
    </section>
  `,
  styles: [`:host { display:block; color:var(--text-primary); } .argo-alert { border:1px solid var(--border-subtle); padding:12px; border-radius:6px; background:var(--bg-surface); } .verbatim { white-space:pre-wrap; overflow-wrap:anywhere; } code { overflow-wrap:anywhere; }`],
})
export class ArgocdPanelComponent {
  @Input() project: any;
  @Input() status: any;
  @Output() reload = new EventEmitter<void>();
  private http = inject(HttpClient);
  ngOnChanges(changes: SimpleChanges) {
    if (changes['status'] && this.environment !== 'development' && this.project?.id && !this.loading && !this.busy) {
      void this.loadEnvironmentStatus();
    }
  }
  environment = 'development';
  loading = false;
  private environmentStatus: any = null;
  get view(): any { return this.environment === 'development' ? this.status : this.environmentStatus; }
  async selectEnvironment(environment: string) {
    this.environment = environment;
    this.environmentStatus = null;
    this.error = this.notice = '';
    if (environment === 'development') { this.reload.emit(); return; }
    await this.loadEnvironmentStatus();
  }
  private async loadEnvironmentStatus() {
    this.loading = true;
    try {
      this.environmentStatus = await firstValueFrom(this.http.get(`/api/projects/${encodeURIComponent(this.project.id)}/argocd-status`, { params: { env: this.environment } }));
    } catch (err: any) { this.error = err?.error?.error || 'Could not load ArgoCD status'; }
    finally { this.loading = false; }
  }
  busy: 'refresh' | 'sync' | null = null;
  error = '';
  notice = '';
  async act(action: 'refresh' | 'sync') {
    if (this.busy || !this.project?.id) return;
    this.busy = action;
    this.error = this.notice = '';
    try {
      await firstValueFrom(this.http.post(`/api/projects/${encodeURIComponent(this.project.id)}/argocd/${action}`, { env: this.environment }));
      this.notice = action === 'sync' ? 'Sync requested. ArgoCD will report progress here.' : 'Hard refresh requested.';
      if (this.environment === 'development') this.reload.emit();
      else await this.loadEnvironmentStatus();
    } catch (err: any) {
      this.error = err?.error?.error || 'ArgoCD action failed';
    } finally { this.busy = null; }
  }
}
