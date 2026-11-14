import { Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ToastService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-builds-panel', standalone: true, imports: [CommonModule, FormsModule],
  template: `
    <section class="builds-panel" aria-labelledby="builds-title">
      <h3 id="builds-title">Builds</h3>
      <p>Turn a branch into an app. Cairn uses your Dockerfile, or detects the language with Buildpacks. Apps must listen on port 8080 and run as a non-root user.</p>
      @if (error) { <p role="alert">{{ error }}</p> }
      @if (!enabled && loaded) { <p>Source builds are disabled. Ask your administrator to enable them on the server.</p> }
      @if (enabled && canManage) {
        <div class="build-controls">
          <label>Environment <select [(ngModel)]="environmentId" aria-label="Build environment">
            @for (env of environments; track env.id) { <option [value]="env.id">{{ env.name }}</option> }
          </select></label>
          <label>Branch <input [(ngModel)]="branch" placeholder="Branch name" aria-label="Build branch"></label>
          <button type="button" class="btn btn-primary" [disabled]="busy || !branch || !environmentId" (click)="buildNow()">Build now</button>
        </div>
        @for (env of environments; track env.id) {
          <div class="build-controls">
            <label><input type="checkbox" [(ngModel)]="env.buildOnPush"> Build from source on push · {{ env.name }}</label>
            <label>Linked branch <input [(ngModel)]="env.buildBranch" [attr.aria-label]="env.name + ' linked branch'"></label>
            <button type="button" class="btn" [disabled]="busy || !env.buildBranch" (click)="saveSettings(env)">Save</button>
          </div>
        }
        <p>When enabled, a push to the linked branch builds and deploys this environment. A failed build leaves the running app in place.</p>
      }
      <div class="build-table">
        <table><thead><tr><th>Commit</th><th>Branch</th><th>Status</th><th>Duration</th><th>Triggered by</th><th>Logs</th></tr></thead>
          <tbody>
            @for (build of builds; track build.id) {
              <tr><td><code>{{ build.commitSha | slice:0:12 }}</code></td><td>{{ build.branch }}</td>
                <td><span class="status" [class.status-ok]="build.status === 'succeeded'" [class.status-down]="build.status === 'failed' || build.status === 'cancelled'" [class.status-warn]="build.status === 'queued' || build.status === 'building'">{{ build.status }}</span>
                  @if (build.error && (build.status === 'failed' || build.status === 'cancelled')) { <small class="build-reason">{{ build.error }}</small> }</td>
                <td>{{ duration(build) }}</td><td>{{ build.triggeredBy }}</td>
                <td><button class="btn" type="button" (click)="selectBuild(build.id)">View logs</button></td></tr>
            } @empty { <tr><td colspan="6">No builds yet.</td></tr> }
          </tbody>
        </table>
      </div>
      @if (selectedBuildId) {
        <h4>Build logs</h4><p>Logs refresh every five seconds. Build success means the image is ready; deployment progress appears in the deployment history.</p>
        <pre aria-label="Build logs">{{ logs || 'Waiting for logs…' }}</pre>
      }
    </section>`,
  styles: [`
    .builds-panel { border: 1px solid rgb(var(--line)); border-radius: 8px; padding: 20px; color: rgb(var(--fg)); }
    p { color: rgb(var(--fg-2)); }
    .build-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-block: 16px; }
    label { display: flex; align-items: center; gap: 8px; }
    input, select { background: rgb(var(--surface)); color: rgb(var(--fg)); border: 1px solid rgb(var(--line)); border-radius: 4px; padding: 6px; }
    .build-table { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; }
    td, th { padding: 8px; border-bottom: 1px solid rgb(var(--line)); }
    .build-reason { display: block; margin-top: 4px; color: rgb(var(--fg-2)); }
    pre { max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: rgb(var(--surface)); padding: 16px; }
  `],
})
export class BuildsPanelComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) projectId = '';
  @Input() canManage = false;
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  private generation = 0;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  builds: any[] = [];
  environments: any[] = [];
  enabled = false;
  loaded = false;
  busy = false;
  error = '';
  environmentId = '';
  branch = '';
  selectedBuildId = '';
  logs = '';
  private get url() { return `/api/projects/${encodeURIComponent(this.projectId)}/builds`; }

  ngOnChanges() {
    this.generation++; clearInterval(this.timer);
    this.builds = []; this.environments = []; this.selectedBuildId = ''; this.logs = '';
    this.environmentId = ''; this.branch = ''; this.loaded = false; this.refreshing = false; this.busy = false;
    if (!this.projectId) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5000);
  }
  ngOnDestroy() { this.generation++; clearInterval(this.timer); }

  async refresh() {
    if (this.refreshing) return;
    const generation = this.generation;
    this.refreshing = true;
    try {
      const result: any = await firstValueFrom(this.http.get(this.url));
      if (generation !== this.generation) return;
      this.builds = result.builds; this.enabled = result.enabled; this.error = '';
      if (!this.loaded) {
        this.environments = result.environments;
        this.environmentId = this.environments[0]?.id || '';
        this.branch = this.environments[0]?.buildBranch || '';
      }
      this.loaded = true;
      if (this.selectedBuildId) await this.loadLogs(this.selectedBuildId, generation);
    } catch (error) { if (generation === this.generation) this.error = errorText(error, 'Could not load builds'); }
    finally { if (generation === this.generation) this.refreshing = false; }
  }
  async selectBuild(id: string) {
    this.selectedBuildId = id; this.logs = '';
    try { await this.loadLogs(id, this.generation); }
    catch (error) { this.toast.error(errorText(error, 'Could not load build logs')); }
  }
  private async loadLogs(id: string, generation: number) {
    const result: any = await firstValueFrom(this.http.get(`${this.url}/${encodeURIComponent(id)}/logs`));
    if (generation === this.generation && id === this.selectedBuildId) this.logs = result.logs;
  }
  async buildNow() {
    const generation = this.generation; this.busy = true;
    try {
      await firstValueFrom(this.http.post(this.url, { environmentId: this.environmentId, branch: this.branch }));
      if (generation === this.generation) { this.toast.ok('Build queued'); await this.refresh(); }
    } catch (error) { this.toast.error(errorText(error, 'Could not queue build')); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  async saveSettings(env: any) {
    const generation = this.generation; this.busy = true;
    try {
      await firstValueFrom(this.http.patch(`${this.url}/settings`, { environmentId: env.id, buildOnPush: env.buildOnPush, branch: env.buildBranch }));
      if (generation === this.generation) this.toast.ok('Build settings saved');
    } catch (error) { this.toast.error(errorText(error, 'Could not save build settings')); }
    finally { if (generation === this.generation) this.busy = false; }
  }
  duration(build: any): string {
    if (!build.startedAt) return 'Queued';
    return `${Math.max(0, Math.round(((build.finishedAt ? Date.parse(build.finishedAt) : Date.now()) - Date.parse(build.startedAt)) / 1000))}s`;
  }
}
