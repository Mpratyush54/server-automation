import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
<div>
  <!-- Page Header -->
  <div class="card" style="background:linear-gradient(135deg, rgba(99,102,241,0.06), rgba(139,92,246,0.06)); border-color:rgba(99,102,241,0.2); margin-bottom:24px;">
    <h1 style="margin:0 0 6px 0; font-size:1.6rem; background:linear-gradient(to right, #fff, #94a3b8); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">⚙️ Platform Settings</h1>
    <p style="margin:0; color:var(--color-text-secondary); font-size:0.9rem;">Configure SMTP, storage providers, and platform-level integrations.</p>
  </div>

  <!-- Tab Navigation -->
  <div style="display:flex; gap:8px; margin-bottom:24px; border-bottom:1px solid var(--border-glass); padding-bottom:12px;">
    <button class="btn btn-sm" [class.btn-primary]="activeTab === 'smtp'" (click)="activeTab = 'smtp'">📧 SMTP / Email</button>
    <button class="btn btn-sm" [class.btn-primary]="activeTab === 'storage'" (click)="activeTab = 'storage'">🗄️ Storage Providers</button>
    <button class="btn btn-sm" [class.btn-primary]="activeTab === 'integrations'" (click)="activeTab = 'integrations'">🔗 Integrations</button>
  </div>

  <!-- ─────────────────── SMTP TAB ─────────────────── -->
  <div *ngIf="activeTab === 'smtp'">
    <div class="grid-2" style="align-items:start;">
      <!-- SMTP Form -->
      <div class="card" style="padding:24px; background:rgba(15,23,42,0.6);">
        <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:20px;">Add SMTP Configuration</h2>
        <div class="form-group">
          <label>Name / Label</label>
          <input [(ngModel)]="newSmtp.name" placeholder="Production SES" style="width:100%;">
        </div>
        <div class="form-group">
          <label>Provider</label>
          <select [(ngModel)]="newSmtp.provider" style="width:100%;">
            <option value="custom">Custom SMTP</option>
            <option value="ses">AWS SES</option>
            <option value="sendgrid">SendGrid</option>
            <option value="mailgun">Mailgun</option>
          </select>
        </div>
        <div *ngIf="newSmtp.provider === 'custom' || newSmtp.provider === 'ses'" class="form-group">
          <label>SMTP Host</label>
          <input [(ngModel)]="newSmtp.host" placeholder="smtp.example.com" style="width:100%;">
        </div>
        <div *ngIf="newSmtp.provider === 'custom'" class="form-group">
          <label>Port</label>
          <input type="number" [(ngModel)]="newSmtp.port" placeholder="587" style="width:100%;">
        </div>
        <div *ngIf="newSmtp.provider !== 'sendgrid'" class="form-group">
          <label>Username / Access Key</label>
          <input [(ngModel)]="newSmtp.username" placeholder="AKIAIOSFODNN7EXAMPLE" style="width:100%;">
        </div>
        <div class="form-group">
          <label>{{ newSmtp.provider === 'sendgrid' ? 'API Key' : newSmtp.provider === 'mailgun' ? 'API Key' : 'Password / Secret' }}</label>
          <input type="password" [(ngModel)]="newSmtp.password" placeholder="••••••••" style="width:100%;">
        </div>
        <div class="form-group">
          <label>From Email Address</label>
          <input [(ngModel)]="newSmtp.fromEmail" placeholder="noreply@yourdomain.com" style="width:100%;">
        </div>
        <div class="form-group">
          <label>From Name (optional)</label>
          <input [(ngModel)]="newSmtp.fromName" placeholder="CAPS Platform" style="width:100%;">
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:20px;">
          <input type="checkbox" id="smtpDefault" [(ngModel)]="newSmtp.isDefault" style="width:16px; height:16px;">
          <label for="smtpDefault" style="margin:0; cursor:pointer; font-size:0.85rem;">Set as default mail sender</label>
        </div>
        <button class="btn btn-primary" (click)="saveSmtp()" style="width:100%;">Save SMTP Config</button>
      </div>

      <!-- SMTP List -->
      <div class="card" style="padding:24px;">
        <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:16px;">Configured SMTP Providers</h2>
        <div *ngFor="let s of smtpConfigs" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-glass); border-radius:10px; padding:16px; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="font-weight:700; color:#f8fafc; margin-bottom:4px;">{{ s.name }}</div>
              <div style="font-size:0.78rem; color:var(--color-text-secondary);">{{ s.provider | uppercase }} • {{ s.fromEmail }}</div>
              <div *ngIf="s.isDefault" style="display:inline-block; background:rgba(16,185,129,0.15); color:#10b981; font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:4px; margin-top:6px;">✓ DEFAULT</div>
            </div>
            <div style="display:flex; gap:8px; flex-shrink:0;">
              <button class="btn btn-sm" (click)="testSmtp(s)" style="font-size:0.75rem;">Test</button>
              <button class="btn btn-sm" (click)="deleteSmtp(s.id)" style="font-size:0.75rem; color:#ef4444;">Delete</button>
            </div>
          </div>
          <div *ngIf="testResults[s.id]" style="margin-top:10px; padding:8px 12px; border-radius:6px; font-size:0.78rem;"
            [style.background]="testResults[s.id].success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'"
            [style.color]="testResults[s.id].success ? '#34d399' : '#f87171'">
            {{ testResults[s.id].success ? '✅ Test email sent successfully' : '❌ ' + testResults[s.id].error }}
          </div>
        </div>
        <div *ngIf="smtpConfigs.length === 0" style="color:var(--color-text-muted); text-align:center; padding:40px 20px;">
          No SMTP configs yet. Add one to enable deployment notifications.
        </div>
      </div>
    </div>
  </div>

  <!-- ─────────────────── STORAGE TAB ─────────────────── -->
  <div *ngIf="activeTab === 'storage'">
    <div class="grid-2" style="align-items:start;">
      <!-- Storage Form -->
      <div class="card" style="padding:24px; background:rgba(15,23,42,0.6);">
        <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:20px;">Add Storage Provider</h2>
        <div class="form-group">
          <label>Name / Label</label>
          <input [(ngModel)]="newStorage.name" placeholder="Production MinIO" style="width:100%;">
        </div>
        <div class="form-group">
          <label>Provider Type</label>
          <select [(ngModel)]="newStorage.providerType" style="width:100%;">
            <option value="minio">MinIO (Self-hosted)</option>
            <option value="s3">AWS S3 / S3-Compatible</option>
            <option value="google_drive">Google Drive</option>
            <option value="local">Local Filesystem</option>
          </select>
        </div>
        <div *ngIf="newStorage.providerType === 'minio' || newStorage.providerType === 's3'" class="form-group">
          <label>Endpoint URL (MinIO / S3-compatible)</label>
          <input [(ngModel)]="newStorage.endpointUrl" placeholder="http://minio:9000" style="width:100%;">
        </div>
        <div *ngIf="newStorage.providerType !== 'local' && newStorage.providerType !== 'google_drive'">
          <div class="form-group">
            <label>Access Key / Key ID</label>
            <input [(ngModel)]="newStorage.credentials.accessKeyId" placeholder="minioadmin" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Secret Key</label>
            <input type="password" [(ngModel)]="newStorage.credentials.secretAccessKey" placeholder="••••••••" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Bucket Name</label>
            <input [(ngModel)]="newStorage.bucketName" placeholder="caps-backups" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Region (AWS S3 only)</label>
            <input [(ngModel)]="newStorage.credentials.region" placeholder="us-east-1" style="width:100%;">
          </div>
        </div>
        <div *ngIf="newStorage.providerType === 'google_drive'">
          <div class="form-group">
            <label>Client ID</label>
            <input [(ngModel)]="newStorage.credentials.clientId" placeholder="xxxx.apps.googleusercontent.com" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Client Secret</label>
            <input type="password" [(ngModel)]="newStorage.credentials.clientSecret" placeholder="••••••••" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Refresh Token</label>
            <input type="password" [(ngModel)]="newStorage.credentials.refreshToken" placeholder="1//0g..." style="width:100%;">
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:20px;">
          <input type="checkbox" id="storageDefault" [(ngModel)]="newStorage.isDefault" style="width:16px; height:16px;">
          <label for="storageDefault" style="margin:0; cursor:pointer; font-size:0.85rem;">Set as default storage</label>
        </div>
        <button class="btn btn-primary" (click)="saveStorage()" style="width:100%;">Save Storage Provider</button>
      </div>

      <!-- Storage List -->
      <div class="card" style="padding:24px;">
        <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:16px;">Configured Storage Providers</h2>
        <div *ngFor="let s of storageProviders" style="background:rgba(255,255,255,0.03); border:1px solid var(--border-glass); border-radius:10px; padding:16px; margin-bottom:12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="font-weight:700; color:#f8fafc; margin-bottom:4px;">{{ s.name }}</div>
              <div style="font-size:0.78rem; color:var(--color-text-secondary);">
                {{ s.providerType | uppercase }}
                <span *ngIf="s.bucketName"> • {{ s.bucketName }}</span>
                <span *ngIf="s.endpointUrl"> • {{ s.endpointUrl }}</span>
              </div>
              <div *ngIf="s.isDefault" style="display:inline-block; background:rgba(99,102,241,0.15); color:#818cf8; font-size:0.7rem; font-weight:700; padding:2px 8px; border-radius:4px; margin-top:6px;">✓ DEFAULT</div>
            </div>
            <div style="display:flex; gap:8px; flex-shrink:0;">
              <button class="btn btn-sm" (click)="testStorage(s)" style="font-size:0.75rem;">Test</button>
              <button *ngIf="!s.isDefault" class="btn btn-sm" (click)="setDefaultStorage(s.id)" style="font-size:0.75rem;">Set Default</button>
              <button class="btn btn-sm" (click)="deleteStorage(s.id)" style="font-size:0.75rem; color:#ef4444;">Delete</button>
            </div>
          </div>
          <div *ngIf="storageTestResults[s.id]" style="margin-top:10px; padding:8px 12px; border-radius:6px; font-size:0.78rem;"
            [style.background]="storageTestResults[s.id].success ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'"
            [style.color]="storageTestResults[s.id].success ? '#34d399' : '#f87171'">
            {{ storageTestResults[s.id].success ? '✅ Connection successful' : '❌ ' + storageTestResults[s.id].message }}
          </div>
        </div>
        <div *ngIf="storageProviders.length === 0" style="color:var(--color-text-muted); text-align:center; padding:40px 20px;">
          No storage providers configured. Add one to enable database backups.
        </div>
      </div>
    </div>
  </div>

  <!-- ─────────────────── INTEGRATIONS TAB ─────────────────── -->
  <div *ngIf="activeTab === 'integrations'" class="grid-2" style="align-items:start;">
    <div class="card" style="padding:24px; background:rgba(15,23,42,0.6);">
      <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:16px;">🐙 GitHub Integration</h2>
      <p style="color:var(--color-text-secondary); font-size:0.83rem; margin-bottom:16px;">Configure GitHub webhooks and auto-deploy on push. CAPS will auto-register webhooks when you link a project to a GitHub repo.</p>
      <div class="form-group">
        <label>GitHub Personal Access Token</label>
        <input type="password" [(ngModel)]="integrations.githubToken" placeholder="ghp_xxxx..." style="width:100%;">
      </div>
      <div class="form-group">
        <label>Webhook Secret (auto-generated)</label>
        <input [value]="integrations.webhookSecret || 'Not set'" [readonly]="true" style="width:100%; background:rgba(255,255,255,0.03); cursor:not-allowed;">
      </div>
      <button class="btn btn-primary" (click)="saveGitHubToken()" style="margin-bottom:8px;">Save GitHub Token</button>
      <div style="font-size:0.78rem; color:var(--color-text-secondary); margin-top:8px;">Webhook URL: <code style="background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px;">{{ apiBase }}/webhooks/github</code></div>
    </div>

    <div class="card" style="padding:24px; background:rgba(15,23,42,0.6);">
      <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:16px;">🦊 GitLab Integration</h2>
      <p style="color:var(--color-text-secondary); font-size:0.83rem; margin-bottom:16px;">Connect to GitLab to trigger CI/CD pipelines and sync merge request events.</p>
      <div class="form-group">
        <label>GitLab Personal Access Token</label>
        <input type="password" [(ngModel)]="integrations.gitlabToken" placeholder="glpat-xxxx..." style="width:100%;">
      </div>
      <div class="form-group">
        <label>GitLab Instance URL</label>
        <input [(ngModel)]="integrations.gitlabUrl" placeholder="https://gitlab.com" style="width:100%;">
      </div>
      <button class="btn btn-primary" (click)="saveGitLabToken()">Save GitLab Config</button>
      <div style="font-size:0.78rem; color:var(--color-text-secondary); margin-top:8px;">Webhook URL: <code style="background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px;">{{ apiBase }}/webhooks/gitlab</code></div>
    </div>

    <div class="card" style="padding:24px; background:rgba(15,23,42,0.6);">
      <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:16px;">📋 ClickUp Integration</h2>
      <div class="form-group">
        <label>ClickUp API Token</label>
        <input type="password" [(ngModel)]="integrations.clickupToken" placeholder="pk_xxxx..." style="width:100%;">
      </div>
      <div class="form-group">
        <label>Default List ID</label>
        <input [(ngModel)]="integrations.clickupListId" placeholder="901234567890" style="width:100%;">
      </div>
      <button class="btn btn-primary" (click)="saveClickupConfig()">Save ClickUp Config</button>
    </div>

    <div class="card" style="padding:24px; background:rgba(15,23,42,0.6);">
      <h2 style="font-size:1.05rem; border:0; padding:0; margin-bottom:16px;">🔐 Infisical Integration</h2>
      <div class="form-group">
        <label>Infisical Base URL</label>
        <input [(ngModel)]="integrations.infisicalUrl" placeholder="https://infisical.company.local" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Service Token</label>
        <input type="password" [(ngModel)]="integrations.infisicalToken" placeholder="st.xxxx..." style="width:100%;">
      </div>
      <button class="btn btn-primary" (click)="saveInfisicalConfig()">Save Infisical Config</button>
      <p style="color:var(--color-text-secondary); font-size:0.78rem; margin-top:12px;">All secrets provisioned for projects will be synced to this Infisical instance automatically.</p>
    </div>
  </div>
</div>
  `
})
export class SettingsComponent implements OnInit {
  activeTab = 'smtp';
  smtpConfigs: any[] = [];
  storageProviders: any[] = [];
  testResults: Record<string, any> = {};
  storageTestResults: Record<string, any> = {};
  apiBase = '/api';

  newSmtp: any = { name: '', provider: 'custom', host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: '', isDefault: false };
  newStorage: any = { name: '', providerType: 'minio', endpointUrl: '', bucketName: '', isDefault: false, credentials: { accessKeyId: '', secretAccessKey: '', region: '', clientId: '', clientSecret: '', refreshToken: '' } };
  integrations: any = { githubToken: '', gitlabToken: '', gitlabUrl: 'https://gitlab.com', clickupToken: '', clickupListId: '', infisicalUrl: '', infisicalToken: '', webhookSecret: '' };

  constructor(private api: ApiService) {}

  async ngOnInit() {
    await Promise.all([this.loadSmtp(), this.loadStorage()]);
    // Load env-based defaults
    this.apiBase = window.location.origin.replace('4200', '3000') + '/api';
    this.integrations.webhookSecret = localStorage.getItem('caps_webhook_secret') || 'Use CAPS_WEBHOOK_SECRET env var';
  }

  async loadSmtp() {
    try { this.smtpConfigs = await firstValueFrom(this.api.getSmtpConfigs()); } catch { this.smtpConfigs = []; }
  }

  async loadStorage() {
    try { this.storageProviders = await firstValueFrom(this.api.getStorageProviders()); } catch { this.storageProviders = []; }
  }

  async saveSmtp() {
    try {
      const payload = { ...this.newSmtp, apiKey: this.newSmtp.password };
      await firstValueFrom(this.api.createSmtpConfig(payload));
      this.newSmtp = { name: '', provider: 'custom', host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: '', isDefault: false };
      await this.loadSmtp();
    } catch (err: any) { alert('Failed: ' + (err.error?.error || err.message)); }
  }

  async testSmtp(s: any) {
    try {
      const res = await firstValueFrom(this.api.testSmtpConfig(s.id, s.fromEmail));
      this.testResults[s.id] = res;
    } catch (err: any) { this.testResults[s.id] = { success: false, error: err.error?.error || err.message }; }
  }

  async deleteSmtp(id: string) {
    if (!confirm('Remove SMTP config?')) return;
    await firstValueFrom(this.api.deleteSmtpConfig(id));
    await this.loadSmtp();
  }

  async saveStorage() {
    try {
      await firstValueFrom(this.api.createStorageProvider(this.newStorage));
      this.newStorage = { name: '', providerType: 'minio', endpointUrl: '', bucketName: '', isDefault: false, credentials: {} };
      await this.loadStorage();
    } catch (err: any) { alert('Failed: ' + (err.error?.error || err.message)); }
  }

  async testStorage(s: any) {
    try {
      const res = await firstValueFrom(this.api.testStorageProvider(s.id));
      this.storageTestResults[s.id] = res;
    } catch (err: any) { this.storageTestResults[s.id] = { success: false, message: err.error?.error || err.message }; }
  }

  async setDefaultStorage(id: string) {
    await firstValueFrom(this.api.setDefaultStorage(id));
    await this.loadStorage();
  }

  async deleteStorage(id: string) {
    if (!confirm('Remove storage provider?')) return;
    await firstValueFrom(this.api.deleteStorageProvider(id));
    await this.loadStorage();
  }

  saveGitHubToken() { alert('GitHub token saved (env var approach — set GITHUB_TOKEN on your server).'); }
  saveGitLabToken() { alert('GitLab config saved (env var approach — set GITLAB_URL and GITLAB_TOKEN on your server).'); }
  saveClickupConfig() { alert('ClickUp config saved (env var approach — set CLICKUP_API_TOKEN on your server).'); }
  saveInfisicalConfig() { alert('Infisical config saved (env var approach — set INFISICAL_URL and INFISICAL_TOKEN on your server).'); }
}
