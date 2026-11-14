import { Component, EventEmitter, Input, Output, SimpleChanges, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-argocd-panel', standalone: true,
  template: `
    <section class="card card-flush" aria-label="ArgoCD application">
      <div class="card-header">
        <h2>GitOps / Argo CD</h2>
        <div class="argo-actions">
          <select class="argo-env" aria-label="ArgoCD environment" [value]="environment" (change)="selectEnvironment($any($event.target).value)" [disabled]="!!busy || loading">
            @for (env of project?.environments || []; track env.id) { <option [value]="env.name">{{ env.name }}</option> }
          </select>
          <button class="btn btn-sm" (click)="act('refresh')" [disabled]="!!busy || loading || !view?.connected">{{ busy === 'refresh' ? 'Refreshing...' : 'Refresh' }}</button>
          <button class="btn btn-sm" (click)="act('sync')" [disabled]="!!busy || loading || !view?.connected || view?.operationState?.phase === 'Running' || view?.operationState?.phase === 'Terminating'">{{ busy === 'sync' ? 'Requesting sync...' : 'Sync' }}</button>
        </div>
      </div>
      <div class="argo-body">
        <dl class="facts">
          <dt>Sync</dt><dd><span class="status" [class.status-ok]="view?.syncStatus === 'Synced'" [class.status-warn]="view?.syncStatus === 'OutOfSync'">{{ view?.syncStatus || 'Unknown' }}</span></dd>
          <dt>Health</dt><dd><span class="status" [class.status-ok]="view?.healthStatus === 'Healthy'" [class.status-warn]="view?.healthStatus === 'Progressing'" [class.status-down]="view?.healthStatus === 'Degraded' || view?.healthStatus === 'Missing'">{{ view?.healthStatus || 'Unknown' }}</span></dd>
          <dt>Branch / target</dt><dd class="mono">{{ view?.branch || project?.gitRevision || project?.defaultBranch || 'HEAD' }}</dd>
          <dt>Revision</dt><dd class="mono">{{ view?.sync?.revision || view?.revision || 'Unknown' }}</dd>
          @if (view?.resources) {
            <dt>Resources</dt><dd>{{ view.resources.synced }} / {{ view.resources.total }} synced, {{ view.resources.degraded }} degraded</dd>
          }
        </dl>
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
        @if (loading) { <p role="status" class="argo-note">Loading Argo CD status...</p> }
        @if (error) { <p role="alert" class="argo-alert">{{ error }}</p> }
        @if (notice) { <p role="status" class="argo-note">{{ notice }}</p> }
      </div>
    </section>
  `,
  styles: [`
    :host { display: block; }
    .argo-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
    .argo-env { width: auto; min-width: 9rem; height: 2rem; padding-top: 0; padding-bottom: 0; }
    .argo-body { padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
    .argo-alert { margin: 0; border: 1px solid rgb(var(--down) / 0.4); background: rgb(var(--down) / 0.08); padding: 0.75rem 1rem; border-radius: 6px; color: rgb(var(--fg)); font-size: 0.8125rem; }
    .argo-alert p { margin: 0; }
    .argo-alert p + p { margin-top: 0.5rem; }
    .argo-note { margin: 0; font-size: 0.8125rem; color: rgb(var(--fg-2)); }
    .verbatim { white-space: pre-wrap; overflow-wrap: anywhere; }
  `],
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
