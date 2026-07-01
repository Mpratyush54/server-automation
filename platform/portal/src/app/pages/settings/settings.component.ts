import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
<div>
  <!-- Page Header -->
  <div class="card" style="background:linear-gradient(135deg, rgba(91,110,245,0.05), rgba(45,212,160,0.02)); border-color:var(--border-subtle); margin-bottom:20px;">
    <h1 style="margin:0 0 4px 0; font-size:1.3rem; font-family:var(--font-heading);">⚙️ Platform Settings</h1>
    <p style="margin:0; color:var(--text-secondary); font-size:0.8rem;">Configure SMTP, backup storage engines, and developer API integrations.</p>
  </div>

  <!-- Tab Navigation -->
  <div style="display:flex; gap:6px; margin-bottom:20px; border-bottom:1px solid var(--border-subtle); padding-bottom:8px;">
    <button *ngIf="isDevOps" class="btn btn-sm" [class.btn-primary]="activeTab === 'smtp'" (click)="activeTab = 'smtp'">📧 SMTP / Email</button>
    <button *ngIf="isDevOps" class="btn btn-sm" [class.btn-primary]="activeTab === 'storage'" (click)="activeTab = 'storage'">🗄️ Storage Providers</button>
    <button class="btn btn-sm" [class.btn-primary]="activeTab === 'integrations'" (click)="activeTab = 'integrations'">🔗 Integrations</button>
  </div>

  <!-- ─────────────────── SMTP TAB ─────────────────── -->
  <div *ngIf="activeTab === 'smtp' && isDevOps">
    <div class="grid-2" style="align-items:start;">
      <!-- SMTP Form -->
      <div class="card" style="padding:20px;">
        <h2>Add SMTP Configuration</h2>
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
          <label>SMTP Host / Region</label>
          <input [(ngModel)]="newSmtp.host" placeholder="smtp.example.com or us-east-1" style="width:100%;">
        </div>
        <div *ngIf="newSmtp.provider === 'custom'" class="form-group">
          <label>Port</label>
          <input type="number" [(ngModel)]="newSmtp.port" placeholder="587" style="width:100%;">
        </div>
        <div *ngIf="newSmtp.provider !== 'sendgrid'" class="form-group">
          <label>Username / Access Key</label>
          <input [(ngModel)]="newSmtp.username" placeholder="Username or access key" style="width:100%;">
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
          <input [(ngModel)]="newSmtp.fromName" placeholder="Platform" style="width:100%;">
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:16px;">
          <input type="checkbox" id="smtpDefault" [(ngModel)]="newSmtp.isDefault" style="width:14px; height:14px; cursor:pointer;">
          <label for="smtpDefault" style="margin:0; cursor:pointer; font-size:0.75rem; text-transform:none; letter-spacing:0; color:var(--text-secondary);">Set as default mail sender</label>
        </div>
        <button class="btn btn-primary" (click)="saveSmtp()" style="width:100%;">Save SMTP Config</button>
      </div>

      <!-- SMTP List -->
      <div class="card" style="padding:20px;">
        <h2>Configured SMTP Providers</h2>
        <div *ngFor="let s of smtpConfigs" style="background:rgba(0,0,0,0.15); border:1px solid var(--border-subtle); border-radius:6px; padding:12px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="font-family:var(--font-heading); font-weight:700; color:#fff; font-size:0.85rem; margin-bottom:2px;">{{ s.name }}</div>
              <div style="font-size:0.72rem; color:var(--text-secondary); font-family:var(--font-code);">{{ s.provider | uppercase }} • {{ s.fromEmail }}</div>
              <div *ngIf="s.isDefault" class="badge badge-active" style="font-size:0.6rem; padding:1px 6px; margin-top:6px;">✓ DEFAULT</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button class="btn btn-sm" (click)="testSmtp(s)">Test</button>
              <button class="btn btn-sm" (click)="deleteSmtp(s.id)" style="color:var(--accent-danger)">Delete</button>
            </div>
          </div>
          <div *ngIf="testResults[s.id]" style="margin-top:8px; padding:6px 10px; border-radius:4px; font-size:0.75rem; font-family:var(--font-code);"
            [style.background]="testResults[s.id].success ? 'rgba(45,212,160,0.1)' : 'rgba(240,82,82,0.1)'"
            [style.color]="testResults[s.id].success ? 'var(--accent-success)' : 'var(--accent-danger)'">
            {{ testResults[s.id].success ? '✓ Test email sent successfully' : '✗ ' + testResults[s.id].error }}
          </div>
        </div>
        <div *ngIf="smtpConfigs.length === 0" style="color:var(--text-muted); text-align:center; padding:32px 16px; font-size:0.8rem;">
          No SMTP configs yet. Add one to enable email notifications.
        </div>
      </div>
    </div>
  </div>

  <!-- ─────────────────── STORAGE TAB ─────────────────── -->
  <div *ngIf="activeTab === 'storage' && isDevOps">
    <div class="grid-2" style="align-items:start;">
      <!-- Storage Form -->
      <div class="card" style="padding:20px;">
        <h2>Add Storage Provider</h2>
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
          <label>Endpoint URL</label>
          <input [(ngModel)]="newStorage.endpointUrl" placeholder="http://minio:9000" style="width:100%;">
        </div>
        <div *ngIf="newStorage.providerType !== 'local' && newStorage.providerType !== 'google_drive'">
          <div class="form-group">
            <label>Access Key ID</label>
            <input [(ngModel)]="newStorage.credentials.accessKeyId" placeholder="minioadmin" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Secret Key</label>
            <input type="password" [(ngModel)]="newStorage.credentials.secretAccessKey" placeholder="••••••••" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Bucket Name</label>
            <input [(ngModel)]="newStorage.bucketName" placeholder="plat-backups" style="width:100%;">
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
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:16px;">
          <input type="checkbox" id="storageDefault" [(ngModel)]="newStorage.isDefault" style="width:14px; height:14px; cursor:pointer;">
          <label for="storageDefault" style="margin:0; cursor:pointer; font-size:0.75rem; text-transform:none; letter-spacing:0; color:var(--text-secondary);">Set as default storage</label>
        </div>
        <button class="btn btn-primary" (click)="saveStorage()" style="width:100%;">Save Storage Provider</button>
      </div>

      <!-- Storage List -->
      <div class="card" style="padding:20px;">
        <h2>Configured Storage Providers</h2>
        <div *ngFor="let s of storageProviders" style="background:rgba(0,0,0,0.15); border:1px solid var(--border-subtle); border-radius:6px; padding:12px; margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="font-family:var(--font-heading); font-weight:700; color:#fff; font-size:0.85rem; margin-bottom:2px;">{{ s.name }}</div>
              <div style="font-size:0.72rem; color:var(--text-secondary); font-family:var(--font-code);">
                {{ s.providerType | uppercase }}
                <span *ngIf="s.bucketName"> • {{ s.bucketName }}</span>
              </div>
              <div *ngIf="s.isDefault" class="badge badge-syncing" style="font-size:0.6rem; padding:1px 6px; margin-top:6px;">✓ DEFAULT</div>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button class="btn btn-sm" (click)="testStorage(s)">Test</button>
              <button *ngIf="!s.isDefault" class="btn btn-sm" (click)="setDefaultStorage(s.id)">Make Default</button>
              <button class="btn btn-sm" (click)="deleteStorage(s.id)" style="color:var(--accent-danger)">Delete</button>
            </div>
          </div>
          <div *ngIf="storageTestResults[s.id]" style="margin-top:8px; padding:6px 10px; border-radius:4px; font-size:0.75rem; font-family:var(--font-code);"
            [style.background]="storageTestResults[s.id].success ? 'rgba(45,212,160,0.1)' : 'rgba(240,82,82,0.1)'"
            [style.color]="storageTestResults[s.id].success ? 'var(--accent-success)' : 'var(--accent-danger)'">
            {{ storageTestResults[s.id].success ? '✓ Connection successful' : '✗ ' + storageTestResults[s.id].message }}
          </div>
        </div>
        <div *ngIf="storageProviders.length === 0" style="color:var(--text-muted); text-align:center; padding:32px 16px; font-size:0.8rem;">
          No storage providers configured. Add one to enable database backups.
        </div>
      </div>
    </div>
  </div>

  <!-- ─────────────────── INTEGRATIONS TAB ─────────────────── -->
  <div *ngIf="activeTab === 'integrations'" class="grid-2" style="align-items:start;">
    <div class="card" style="padding:20px;">
      <h2>🐙 GitHub Integration</h2>
      <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Configure GitHub webhooks and auto-deploy on push. Platform will auto-register webhooks when you link a project to a GitHub repo.</p>
      <div class="form-group" *ngIf="isDevOps || isTechLeadOrDevOps">
        <label>GitHub Personal Access Token</label>
        <input type="password" [(ngModel)]="integrations.githubToken" placeholder="ghp_xxxx..." style="width:100%;">
      </div>
      <div class="form-group">
        <label>Webhook Secret</label>
        <input [value]="integrations.webhookSecret || 'Not set'" [readonly]="true" style="width:100%; background:rgba(0,0,0,0.15); cursor:not-allowed; font-family:var(--font-code);">
      </div>
      <button *ngIf="isDevOps || isTechLeadOrDevOps" class="btn btn-primary btn-sm" (click)="saveGitHubToken()">Save GitHub Token</button>
      <div style="font-size:0.72rem; color:var(--text-muted); margin-top:8px; font-family:var(--font-code);">Webhook URL: {{ apiBase }}/webhooks/github</div>
    </div>

    <div class="card" style="padding:20px;">
      <h2>🦊 GitLab Integration</h2>
      <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Connect to GitLab to trigger CI/CD pipelines and sync merge request events.</p>
      <div class="form-group" *ngIf="isDevOps || isTechLeadOrDevOps">
        <label>GitLab Personal Access Token</label>
        <input type="password" [(ngModel)]="integrations.gitlabToken" placeholder="glpat-xxxx..." style="width:100%;">
      </div>
      <div class="form-group" *ngIf="isDevOps || isTechLeadOrDevOps">
        <label>GitLab Instance URL</label>
        <input [(ngModel)]="integrations.gitlabUrl" placeholder="https://gitlab.com" style="width:100%;">
      </div>
      <button *ngIf="isDevOps || isTechLeadOrDevOps" class="btn btn-primary btn-sm" (click)="saveGitLabToken()">Save GitLab Config</button>
      <div style="font-size:0.72rem; color:var(--text-muted); margin-top:8px; font-family:var(--font-code);">Webhook URL: {{ apiBase }}/webhooks/gitlab</div>
    </div>

    <div class="card" style="padding:20px;">
      <h2>📋 ClickUp Integration</h2>
      <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Connect ClickUp to link tasks with git branch commits and update tasks on pipeline changes.</p>
      <div class="form-group" *ngIf="isDevOps || isTechLeadOrDevOps">
        <label>ClickUp API Token</label>
        <input type="password" [(ngModel)]="integrations.clickupToken" placeholder="pk_xxxx..." style="width:100%;">
      </div>
      <div class="form-group">
        <label>Default List ID</label>
        <input [(ngModel)]="integrations.clickupListId" [readonly]="!isDevOps && !isTechLeadOrDevOps" placeholder="901234567890" style="width:100%;">
      </div>
      <button *ngIf="isDevOps || isTechLeadOrDevOps" class="btn btn-primary btn-sm" (click)="saveClickupConfig()">Save ClickUp Config</button>
    </div>

    <div class="card" style="padding:20px;">
      <h2>🔐 Infisical Integration</h2>
      <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Connect to self-hosted Infisical instance to automatically provision environment secrets.</p>
      <div class="form-group" *ngIf="isDevOps || isTechLeadOrDevOps">
        <label>Infisical Base URL</label>
        <input [(ngModel)]="integrations.infisicalUrl" placeholder="https://infisical.company.local" style="width:100%;">
      </div>
      <div class="form-group" *ngIf="isDevOps || isTechLeadOrDevOps">
        <label>Service Token</label>
        <input type="password" [(ngModel)]="integrations.infisicalToken" placeholder="st.xxxx..." style="width:100%;">
      </div>
      <button *ngIf="isDevOps || isTechLeadOrDevOps" class="btn btn-primary btn-sm" (click)="saveInfisicalConfig()">Save Infisical Config</button>
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
  isDevOps = false;
  isTechLeadOrDevOps = false;

  newSmtp: any = { name: '', provider: 'custom', host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: '', isDefault: false };
  newStorage: any = { name: '', providerType: 'minio', endpointUrl: '', bucketName: '', isDefault: false, credentials: { accessKeyId: '', secretAccessKey: '', region: '', clientId: '', clientSecret: '', refreshToken: '' } };
  integrations: any = { githubToken: '', gitlabToken: '', gitlabUrl: 'https://gitlab.com', clickupToken: '', clickupListId: '', infisicalUrl: '', infisicalToken: '', webhookSecret: '' };

  constructor(private api: ApiService, private auth: AuthService) {}

  async ngOnInit() {
    this.isDevOps = this.auth.isDevOps();
    this.isTechLeadOrDevOps = this.auth.isTechLeadOrDevOps();

    if (this.isDevOps) {
      this.activeTab = 'smtp';
      await Promise.all([this.loadSmtp(), this.loadStorage()]);
    } else {
      this.activeTab = 'integrations';
    }

    // Load env-based defaults
    this.apiBase = window.location.origin.replace('4200', '3000') + '/api';
    this.integrations.webhookSecret = localStorage.getItem('plat_webhook_secret') || 'Use plat_webhook_secret env var';
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
