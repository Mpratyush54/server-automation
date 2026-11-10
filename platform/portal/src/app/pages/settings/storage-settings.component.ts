import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { OperationProgressComponent } from '../../shared/operation-progress.component';

@Component({
  selector: 'app-storage-settings', standalone: true,
  imports: [CommonModule, FormsModule, OperationProgressComponent],
  template: `
    <div class="grid-2">
      <form class="card" (ngSubmit)="save()" style="padding:20px">
        <h2>Add storage provider</h2>
        <div class="form-group"><label for="storage-preset">Provider</label>
          <select id="storage-preset" name="preset" [(ngModel)]="form.preset">
            <option value="aws">AWS S3</option><option value="r2">Cloudflare R2</option>
            <option value="gcs">Google Cloud Storage (HMAC)</option><option value="b2">Backblaze B2</option>
            <option value="s3">Generic S3</option><option value="minio">MinIO</option>
          </select>
        </div>
        <div class="form-group"><label for="storage-name">Label (optional)</label><input id="storage-name" name="name" [(ngModel)]="form.name"></div>
        @if (form.preset === 'r2') {
          <div class="form-group"><label for="storage-account">Account ID</label><input id="storage-account" name="account" [(ngModel)]="form.accountId" required pattern="[a-fA-F0-9]{32}"></div>
        }
        @if (form.preset === 's3' || form.preset === 'minio') {
          <div class="form-group"><label for="storage-endpoint">Endpoint URL</label><input id="storage-endpoint" name="endpoint" type="url" [(ngModel)]="form.endpointUrl" required></div>
        }
        @if (form.preset === 'aws' || form.preset === 'b2' || form.preset === 's3') {
          <div class="form-group"><label for="storage-region">Region</label><input id="storage-region" name="region" [(ngModel)]="form.credentials.region" [required]="form.preset !== 's3'"></div>
        }
        <div class="form-group"><label for="storage-key">Access key ID</label><input id="storage-key" name="key" [(ngModel)]="form.credentials.accessKeyId" required autocomplete="off"></div>
        <div class="form-group"><label for="storage-secret">Secret access key</label><input id="storage-secret" name="secret" type="password" [(ngModel)]="form.credentials.secretAccessKey" required autocomplete="new-password"></div>
        <div class="form-group"><label for="storage-bucket">Bucket</label><input id="storage-bucket" name="bucket" [(ngModel)]="form.bucketName" required></div>
        <label><input name="default" type="checkbox" [(ngModel)]="form.isDefault"> Use as default for new uploads and backups</label>
        <button class="btn btn-primary" type="submit" [disabled]="busy">Save provider</button>
      </form>
      <div class="card" style="padding:20px">
        <h2>Storage providers</h2>
        <p style="color:var(--text-secondary)">Changing the default affects new files. Existing files keep their storage location.</p>
        @for (p of providers; track p.id) {
          <article style="border:1px solid var(--border-subtle);border-radius:6px;padding:12px;margin-bottom:12px">
            <strong>{{p.name}} @if (p.isDefault) {(default)}</strong>
            <span class="badge" [style.color]="p.healthStatus === 'healthy' ? 'var(--accent-success)' : p.healthStatus === 'unhealthy' ? 'var(--accent-danger)' : 'var(--text-secondary)'">{{p.healthStatus || 'unknown'}}</span>
            <p>{{p.bucketName}} @if (p.checkedAt) { &middot; Checked {{p.checkedAt | date:'short'}} }</p>
            @if (p.lastError) { <p style="color:var(--accent-danger)">{{p.lastError}}</p> }
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-sm" [disabled]="busy" (click)="action(p, 'test')">Test connection</button>
              @if (!p.isDefault) { <button class="btn btn-sm" [disabled]="busy" (click)="action(p, 'set-default')">Make default</button> }
              @if (p.providerType === 's3' || p.providerType === 'minio') { <button class="btn btn-sm" [disabled]="busy" (click)="action(p, 'migrate-local')">Copy local files here</button> }
              @if (!p.isDefault && p.name !== 'Bundled MinIO') { <button class="btn btn-sm" [disabled]="busy" (click)="action(p, 'delete')">Delete</button> }
            </div>
          </article>
        } @empty { <p>No configured providers.</p> }
        <p role="status">{{message}}</p>
        <p style="color:var(--text-secondary)">Local migration retains originals, resumes after an API restart, and can be retried after fixing a failure. The local upload directory must be mounted on the API replicas.</p>
        <app-operation-progress [operationId]="operationId" title="Copy local files" (finished)="load()" />
      </div>
    </div>
  `,
  styles: [`input:not([type=checkbox]), select { width:100%; } label { color:var(--text-secondary); } strong { color:var(--text-primary); }`],
})
export class StorageSettingsComponent implements OnInit, OnDestroy {
  private http = inject(HttpClient);
  private timer?: ReturnType<typeof setInterval>;
  providers: any[] = []; busy = false; message = ''; operationId: string | null = null;
  form = this.emptyForm();
  emptyForm() { return { preset: 'aws', name: '', accountId: '', endpointUrl: '', bucketName: '', isDefault: false, credentials: { accessKeyId: '', secretAccessKey: '', region: 'us-east-1' } }; }
  ngOnInit() { void this.load(); this.timer = setInterval(() => void this.load(), 30000); }
  ngOnDestroy() { clearInterval(this.timer); }
  async load() {
    try { this.providers = await firstValueFrom(this.http.get<any[]>('/api/settings/storage')); }
    catch { this.message = 'Could not load storage providers'; }
  }
  async save() {
    this.busy = true;
    try {
      await firstValueFrom(this.http.post('/api/settings/storage', this.form));
      this.form = this.emptyForm(); this.message = 'Provider saved. Test the connection to verify access.';
      await this.load();
    } catch (e: any) { this.message = e.error?.error || 'Could not save provider'; }
    finally { this.busy = false; }
  }
  async action(p: any, action: string) {
    this.busy = true; this.message = '';
    try {
      const url = `/api/settings/storage/${p.id}`;
      const result: any = await firstValueFrom(action === 'delete' ? this.http.delete(url) : action === 'set-default' ? this.http.patch(`${url}/${action}`, {}) : this.http.post(`${url}/${action}`, {}));
      if (action === 'migrate-local') this.operationId = result.id;
      this.message = result.message || (action === 'migrate-local' ? 'Local copy started' : 'Saved');
      await this.load();
    } catch (e: any) { this.message = e.error?.error || 'Storage request failed'; }
    finally { this.busy = false; }
  }
}
