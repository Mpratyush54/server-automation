import { StorageSettingsComponent } from './storage-settings.component';
import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';
import { MfaService } from '../../services/mfa.service';
import { OperationProgressComponent } from '../../shared/operation-progress.component';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, OperationProgressComponent, StorageSettingsComponent],
  template: `
<div>
  <!-- Page Header -->
  <div class="card" style="background:linear-gradient(135deg, rgba(91,110,245,0.05), rgba(45,212,160,0.02)); border-color:var(--border-subtle); margin-bottom:20px;">
    <h1 style="margin:0 0 4px 0; font-size:1.3rem; font-family:var(--font-heading);">⚙️ Platform Settings</h1>
    <p style="margin:0; color:var(--text-secondary); font-size:0.8rem;">Configure GitHub / GitLab login after install, linking tokens, SMTP, storage, and one-click secret rotation.</p>
  </div>

  @if (isDevOps) {
    <div class="card" style="margin-bottom:20px; padding:16px;">
      <h2>Disaster recovery backups</h2>
      <button class="btn btn-sm" (click)="loadBackups()">Refresh backup status</button>
      @if (backupError) {
        <p>{{ backupError }}</p>
      }
      @for (item of backupStatus; track item.operation) {
        <p>
          {{ item.operation === 'backup' ? 'Latest backup' : 'Latest restore test' }}:
          @if (item.status) {
            {{ item.status.success ? 'Passed' : 'FAILED' }} — {{ item.status.finishedAt | date:'medium' }}
            ({{ item.status.bytes | number }} bytes, {{ item.status.durationSeconds | number:'1.0-1' }} seconds)
          } @else {
            No result reported
          }
        </p>
      }
    </div>
  }
  <!-- Tab Navigation -->
  <div style="display:flex; gap:6px; margin-bottom:20px; border-bottom:1px solid var(--border-subtle); padding-bottom:8px; flex-wrap:wrap;">
    @if (isDevOps) {
      <button class="btn btn-sm" [class.btn-primary]="activeTab === 'login'" (click)="activeTab = 'login'">🔐 Login (GitHub / GitLab)</button>
    }
    <button class="btn btn-sm" [class.btn-primary]="activeTab === 'integrations'" (click)="activeTab = 'integrations'">🔗 Git linking</button>
    @if (isDevOps) {
      <button class="btn btn-sm" [class.btn-primary]="activeTab === 'smtp'" (click)="activeTab = 'smtp'">📧 SMTP / Email</button>
    }
    @if (isDevOps) {
      <button class="btn btn-sm" [class.btn-primary]="activeTab === 'storage'" (click)="activeTab = 'storage'">🗄️ Storage Providers</button>
    }
    @if (isDevOps) {
      <button class="btn btn-sm" [class.btn-primary]="activeTab === 'rotate'" (click)="activeTab = 'rotate'">⟳ Rotate secrets</button>
      <button class="btn btn-sm" [class.btn-primary]="activeTab === 'security'" (click)="activeTab = 'security'">🛡️ Security (MFA)</button>
    }
  </div>

  <!-- ─────────────────── LOGIN TAB ─────────────────── -->
  @if (activeTab === 'login' && isDevOps) {
    <div>
      <div class="card" style="margin-bottom:16px; padding:16px;">
        <p style="margin:0; color:var(--text-secondary); font-size:0.8rem;">OAuth apps are optional at install time. Create a GitHub OAuth App and a GitLab Application, paste the client ID/secret here, then users can sign in from the login page. Callback URLs must match exactly.</p>
      </div>
      <div class="grid-2" style="align-items:start;">
        <div class="card" style="padding:20px;">
          <h2>GitHub OAuth login</h2>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <input type="checkbox" id="ghLogin" [(ngModel)]="loginForm.githubLoginEnabled" style="width:14px; height:14px;">
            <label for="ghLogin" style="margin:0; cursor:pointer; text-transform:none; letter-spacing:0;">Enable GitHub login</label>
          </div>
          <div class="form-group">
            <label>Client ID</label>
            <input [(ngModel)]="loginForm.githubClientId" placeholder="Ov23li…" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Client secret {{ loginHints.githubClientSecret?.set ? '(saved)' : '' }}</label>
            <input type="password" [(ngModel)]="loginForm.githubClientSecret" [placeholder]="loginHints.githubClientSecret?.hint || 'Leave blank to keep current'" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Authorization callback URL</label>
            <input [value]="callbackUrls.github" [readonly]="true" style="width:100%; background:rgba(0,0,0,0.15); font-family:var(--font-code); font-size:0.75rem;">
          </div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Status: {{ providers.github?.enabled ? 'Login button is live' : 'Not ready — add client ID and secret' }}</div>
        </div>
        <div class="card" style="padding:20px;">
          <h2>GitLab OAuth login</h2>
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
            <input type="checkbox" id="glLogin" [(ngModel)]="loginForm.gitlabLoginEnabled" style="width:14px; height:14px;">
            <label for="glLogin" style="margin:0; cursor:pointer; text-transform:none; letter-spacing:0;">Enable GitLab login</label>
          </div>
          <div class="form-group">
            <label>GitLab URL</label>
            <input [(ngModel)]="loginForm.gitlabUrl" placeholder="https://gitlab.com" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Application ID</label>
            <input [(ngModel)]="loginForm.gitlabClientId" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Application secret {{ loginHints.gitlabClientSecret?.set ? '(saved)' : '' }}</label>
            <input type="password" [(ngModel)]="loginForm.gitlabClientSecret" [placeholder]="loginHints.gitlabClientSecret?.hint || 'Leave blank to keep current'" style="width:100%;">
          </div>
          <div class="form-group">
            <label>Redirect URI</label>
            <input [value]="callbackUrls.gitlab" [readonly]="true" style="width:100%; background:rgba(0,0,0,0.15); font-family:var(--font-code); font-size:0.75rem;">
          </div>
          <div style="font-size:0.72rem; color:var(--text-muted);">Status: {{ providers.gitlab?.enabled ? 'Login button is live' : 'Not ready — add application ID and secret' }}</div>
        </div>
      </div>
      <button class="btn btn-primary" style="margin-top:12px;" (click)="saveLogin()" [disabled]="savingIntegrations">Save login configuration</button>
      @if (saveMessage) {
        <div style="margin-top:10px; font-size:0.8rem;" [style.color]="saveOk ? 'var(--accent-success)' : 'var(--accent-danger)'">{{ saveMessage }}</div>
      }
    </div>
  }

  <!-- ─────────────────── SMTP TAB ─────────────────── -->
  @if (activeTab === 'smtp' && isDevOps) {
    <div>
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
          @if (newSmtp.provider === 'custom' || newSmtp.provider === 'ses') {
            <div class="form-group">
              <label>SMTP Host / Region</label>
              <input [(ngModel)]="newSmtp.host" placeholder="smtp.example.com or us-east-1" style="width:100%;">
            </div>
          }
          @if (newSmtp.provider === 'custom') {
            <div class="form-group">
              <label>Port</label>
              <input type="number" [(ngModel)]="newSmtp.port" placeholder="587" style="width:100%;">
            </div>
          }
          @if (newSmtp.provider !== 'sendgrid') {
            <div class="form-group">
              <label>Username / Access Key</label>
              <input [(ngModel)]="newSmtp.username" placeholder="Username or access key" style="width:100%;">
            </div>
          }
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
          @for (s of smtpConfigs; track s) {
            <div style="background:rgba(0,0,0,0.15); border:1px solid var(--border-subtle); border-radius:6px; padding:12px; margin-bottom:10px;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                  <div style="font-family:var(--font-heading); font-weight:700; color:#fff; font-size:0.85rem; margin-bottom:2px;">{{ s.name }}</div>
                  <div style="font-size:0.72rem; color:var(--text-secondary); font-family:var(--font-code);">{{ s.provider | uppercase }} • {{ s.fromEmail }}</div>
                  @if (s.isDefault) {
                    <div class="badge badge-active" style="font-size:0.6rem; padding:1px 6px; margin-top:6px;">✓ DEFAULT</div>
                  }
                </div>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                  <button class="btn btn-sm" (click)="testSmtp(s)">Test</button>
                  <button class="btn btn-sm" (click)="deleteSmtp(s.id)" style="color:var(--accent-danger)">Delete</button>
                </div>
              </div>
              @if (testResults[s.id]) {
                <div style="margin-top:8px; padding:6px 10px; border-radius:4px; font-size:0.75rem; font-family:var(--font-code);"
                  [style.background]="testResults[s.id].success ? 'rgba(45,212,160,0.1)' : 'rgba(240,82,82,0.1)'"
                  [style.color]="testResults[s.id].success ? 'var(--accent-success)' : 'var(--accent-danger)'">
                  {{ testResults[s.id].success ? '✓ Test email sent successfully' : '✗ ' + testResults[s.id].error }}
                </div>
              }
            </div>
          }
          @if (smtpConfigs.length === 0) {
            <div style="color:var(--text-muted); text-align:center; padding:32px 16px; font-size:0.8rem;">
              No SMTP configs yet. Add one to enable email notifications.
            </div>
          }
        </div>
      </div>
    </div>
  }

  <!-- ─────────────────── STORAGE TAB ─────────────────── -->
  @if (activeTab === 'storage' && isDevOps) { <app-storage-settings /> }

  @if (activeTab === 'integrations') {
    <div class="grid-2" style="align-items:start;">
      <div class="card" style="padding:20px;">
        <h2>🐙 GitHub linking</h2>
        <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Personal access token used to list branches, register webhooks, and pull repos. Login OAuth is on the Login tab.</p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label>GitHub Personal Access Token {{ loginHints.githubToken?.set ? '(saved)' : '' }}</label>
            <input type="password" [(ngModel)]="integrations.githubToken" placeholder="ghp_xxxx..." style="width:100%;">
          </div>
        }
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label>Default org (optional)</label>
            <input [(ngModel)]="integrations.githubOrg" placeholder="my-org" style="width:100%;">
          </div>
        }
        <div class="form-group">
          <label>Webhook Secret</label>
          <input [value]="loginHints.webhookSecret?.hint || 'Not set'" [readonly]="true" style="width:100%; background:rgba(0,0,0,0.15); cursor:not-allowed; font-family:var(--font-code);">
        </div>
        @if (isDevOps || isTechLeadOrDevOps) {
          <button class="btn btn-primary btn-sm" (click)="saveGitHubToken()">Save GitHub Token</button>
        }
        <div style="font-size:0.72rem; color:var(--text-muted); margin-top:8px; font-family:var(--font-code);">Webhook URL: {{ apiBase }}/webhooks/github</div>
      </div>
      <div class="card" style="padding:20px;">
        <h2>🦊 GitLab linking</h2>
        <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Connect to GitLab to trigger CI/CD pipelines and sync merge request events.</p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label>GitLab Personal Access Token {{ loginHints.gitlabToken?.set ? '(saved)' : '' }}</label>
            <input type="password" [(ngModel)]="integrations.gitlabToken" placeholder="glpat-xxxx..." style="width:100%;">
          </div>
        }
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label>GitLab Instance URL</label>
            <input [(ngModel)]="integrations.gitlabUrl" placeholder="https://gitlab.com" style="width:100%;">
          </div>
        }
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label>Default group (optional)</label>
            <input [(ngModel)]="integrations.gitlabGroup" placeholder="my-group" style="width:100%;">
          </div>
        }
        @if (isDevOps || isTechLeadOrDevOps) {
          <button class="btn btn-primary btn-sm" (click)="saveGitLabToken()">Save GitLab Config</button>
        }
        <div style="font-size:0.72rem; color:var(--text-muted); margin-top:8px; font-family:var(--font-code);">Webhook URL: {{ apiBase }}/webhooks/gitlab</div>
      </div>
      <div class="card" style="padding:20px;">
        <h2>📋 ClickUp Integration</h2>
        <p style="color:var(--text-secondary); font-size:0.78rem; margin-bottom:12px;">Connect ClickUp to link tasks with git branch commits and update tasks on pipeline changes.</p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label>ClickUp API Token {{ loginHints.clickupToken?.set ? '(saved)' : '' }}</label>
            <input type="password" [(ngModel)]="integrations.clickupToken" placeholder="pk_xxxx..." style="width:100%;">
          </div>
        }
        <div class="form-group">
          <label>Default List ID</label>
          <input [(ngModel)]="integrations.clickupListId" [readonly]="!isDevOps && !isTechLeadOrDevOps" placeholder="901234567890" style="width:100%;">
        </div>
        @if (isDevOps || isTechLeadOrDevOps) {
          <button class="btn btn-primary btn-sm" (click)="saveClickupConfig()">Save ClickUp Config</button>
        }
      </div>
    </div>
  }

  <!-- ─────────────────── SECURITY (MFA) TAB ─────────────────── -->
  @if (activeTab === 'security' && isDevOps) {
    <div class="card mfa-policy" style="padding:20px; max-width:720px;">
      <h2>Two-factor authentication policy</h2>
      <p style="color:var(--text-secondary); font-size:0.8rem;">Users in these roles must set up an authenticator app before they can use the portal (setting <code>mfa.requiredRoles</code>). Revealing secrets, rotating platform secrets and creating agent tokens always ask for a recent code.</p>
      <div style="display:flex; gap:14px; flex-wrap:wrap; margin:12px 0;">
        @for (r of allRoles; track r) {
          <label style="display:flex; gap:6px; align-items:center; font-size:0.85rem;">
            <input type="checkbox" [checked]="mfaRoles.includes(r)" (change)="toggleMfaRole(r)" [disabled]="!isAdmin"> {{ r }}
          </label>
        }
      </div>
      @if (mfaPolicySource) {
        <div style="font-size:0.75rem; color:var(--text-muted);">Source: {{ mfaPolicySource }}</div>
      }
      @if (isAdmin) {
        <button class="btn btn-primary btn-sm" style="margin-top:10px;" (click)="saveMfaPolicy()" [disabled]="savingMfaPolicy">Save policy</button>
      } @else {
        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:8px;">Only admins can change the policy.</div>
      }
      @if (mfaPolicyMessage) {
        <div style="margin-top:10px; font-size:0.8rem;">{{ mfaPolicyMessage }}</div>
      }
    </div>
  }

  <!-- ─────────────────── ROTATE TAB ─────────────────── -->
  @if (activeTab === 'rotate' && isDevOps) {
    <div>
      <div class="card" style="padding:20px; max-width:720px;">
        <h2>One-click secret rotation</h2>
        <p style="color:var(--text-secondary); font-size:0.8rem;">Rotates credentials that can be changed live: platform admin, PostgreSQL, Redis, webhook, and Argo CD. If Postgres or Redis rejects the in-pod password after a rotate, the API retries every stored copy (including a write-ahead pending secret) and syncs Kubernetes secrets by itself — no SSH. MongoDB, MinIO, and Portainer are left unchanged so the API does not restart with passwords the servers still reject. JWT is not rotated.</p>
        <p style="color:var(--accent-danger); font-size:0.78rem;">New values are shown <strong>once</strong>. Copy them into a password manager before leaving this page.</p>
        <div class="form-group">
          <label>Type ROTATE to confirm</label>
          <input [(ngModel)]="rotateConfirm" placeholder="ROTATE" style="width:100%; font-family:var(--font-code);">
        </div>
        <button class="btn btn-primary" (click)="rotateSecrets()" [disabled]="rotating || rotateConfirm !== 'ROTATE'">Rotate all secrets</button>
        @if (rotateError) {
          <div style="margin-top:10px; color:var(--accent-danger); font-size:0.8rem;">{{ rotateError }}</div>
        }
        @if (rotationOperationId) {
          <app-operation-progress [operationId]="rotationOperationId" title="Secret rotation"></app-operation-progress>
        }
        @if (rotateValues) {
          <div style="margin-top:16px;">
            <h3 style="font-size:0.9rem;">New values (copy now)</h3>
            <pre style="background:rgba(0,0,0,0.25); padding:12px; border-radius:8px; font-size:0.75rem; overflow:auto;">{{ rotateValues | json }}</pre>
          </div>
        }
        @if (rotateResults.length) {
          <div style="margin-top:12px;">
            @for (r of rotateResults; track r) {
              <div style="font-size:0.75rem; font-family:var(--font-code); margin-bottom:4px;"
                [style.color]="r.ok ? 'var(--accent-success)' : 'var(--accent-danger)'">
                {{ r.ok ? '✓' : '✗' }} {{ r.key }} — {{ r.detail }}
              </div>
            }
          </div>
        }
      </div>
    </div>
  }
</div>
`
})
export class SettingsComponent implements OnInit {
  activeTab = 'login';
  backupStatus: any[] = [];
  backupError = '';
  smtpConfigs: any[] = [];
  storageProviders: any[] = [];
  testResults: Record<string, any> = {};
  storageTestResults: Record<string, any> = {};
  apiBase = '/api';
  isDevOps = false;
  isTechLeadOrDevOps = false;
  savingIntegrations = false;
  saveMessage = '';
  saveOk = false;
  providers: any = { github: { enabled: false }, gitlab: { enabled: false } };
  callbackUrls = { github: '', gitlab: '' };
  loginHints: any = {};
  loginForm: any = {
    githubLoginEnabled: true,
    githubClientId: '',
    githubClientSecret: '',
    gitlabLoginEnabled: true,
    gitlabUrl: 'https://gitlab.com',
    gitlabClientId: '',
    gitlabClientSecret: '',
  };

  newSmtp: any = { name: '', provider: 'custom', host: '', port: 587, secure: false, username: '', password: '', fromEmail: '', fromName: '', isDefault: false };
  newStorage: any = { name: '', providerType: 'minio', endpointUrl: '', bucketName: '', isDefault: false, credentials: { accessKeyId: '', secretAccessKey: '', region: '', clientId: '', clientSecret: '', refreshToken: '' } };
  integrations: any = { githubToken: '', githubOrg: '', gitlabToken: '', gitlabUrl: 'https://gitlab.com', gitlabGroup: '', clickupToken: '', clickupListId: '' };

  rotateConfirm = '';
  rotating = false;
  rotateError = '';
  rotateValues: Record<string, string> | null = null;
  rotateResults: any[] = [];
  /** Latest secret-rotation operation (live step progress, also after an API restart). */
  rotationOperationId: string | null = null;

  private stepUp = inject(StepUpService);
  private mfa = inject(MfaService);
  readonly allRoles = ['admin', 'devops', 'tech_lead', 'developer', 'viewer'];
  isAdmin = false;
  mfaRoles: string[] = [];
  mfaPolicySource = '';
  mfaPolicyMessage = '';
  savingMfaPolicy = false;

  constructor(private api: ApiService, private auth: AuthService) {}

  async loadMfaPolicy() {
    try {
      const p = await firstValueFrom(this.mfa.getPolicy());
      this.mfaRoles = [...(p.requiredRoles || [])];
      this.mfaPolicySource = p.source;
    } catch {
      this.mfaPolicySource = '';
    }
  }

  toggleMfaRole(role: string) {
    this.mfaRoles = this.mfaRoles.includes(role) ? this.mfaRoles.filter((r) => r !== role) : [...this.mfaRoles, role];
  }

  async saveMfaPolicy() {
    this.savingMfaPolicy = true;
    this.mfaPolicyMessage = '';
    try {
      const p: any = await this.stepUp.run(() => firstValueFrom(this.mfa.setPolicy(this.mfaRoles)), 'Change the MFA policy');
      this.mfaRoles = [...(p.requiredRoles || [])];
      this.mfaPolicySource = p.source;
      this.mfaPolicyMessage = 'Policy saved. It applies at each user\'s next sign-in.';
    } catch (err: any) {
      this.mfaPolicyMessage = err?.error?.error || err?.message || 'Failed to save policy';
    } finally {
      this.savingMfaPolicy = false;
    }
  }

  async loadLatestRotation() {
    try {
      const ops = await firstValueFrom(this.api.listOperations({ type: 'platform.secret-rotation', limit: 1 }));
      this.rotationOperationId = (ops as any[])?.[0]?.id || this.rotationOperationId;
    } catch {}
  }

  async ngOnInit() {
    this.isDevOps = this.auth.isDevOps() || this.auth.isAdmin();
    this.isAdmin = this.auth.isAdmin();
    if (this.isDevOps) void this.loadLatestRotation();
    if (this.isDevOps) void this.loadMfaPolicy();
    this.isTechLeadOrDevOps = this.auth.isTechLeadOrDevOps();

    if (this.isDevOps) {
      this.activeTab = 'login';
      await Promise.all([this.loadSmtp(), this.loadStorage(), this.loadIntegrations(), this.loadBackups()]);
    } else {
      this.activeTab = 'integrations';
    }

    this.apiBase = (window.location.origin.includes('4200')
      ? window.location.origin.replace('4200', '3000')
      : window.location.origin) + '/api';
  }

  async loadBackups() {
    try {
      this.backupStatus = (await firstValueFrom(this.api.getBackupStatus())).items;
      this.backupError = '';
    } catch { this.backupError = 'Backup status unavailable. Check the backup jobs and cluster access.'; }
  }

  async loadIntegrations() {
    try {
      const data = await firstValueFrom(this.api.getIntegrations());
      this.loginForm.githubLoginEnabled = data.githubLoginEnabled !== false;
      this.loginForm.githubClientId = data.githubClientId || '';
      this.loginForm.gitlabLoginEnabled = data.gitlabLoginEnabled !== false;
      this.loginForm.gitlabUrl = data.gitlabUrl || 'https://gitlab.com';
      this.loginForm.gitlabClientId = data.gitlabClientId || '';
      this.integrations.gitlabUrl = data.gitlabUrl || 'https://gitlab.com';
      this.integrations.githubOrg = data.githubOrg || '';
      this.integrations.gitlabGroup = data.gitlabGroup || '';
      this.integrations.clickupListId = data.clickupListId || '';
      this.loginHints = data;
      this.providers = data.providers || this.providers;
      this.callbackUrls = data.callbackUrls || this.callbackUrls;
    } catch {
      this.loginHints = {};
    }
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

  private async persistIntegrations(payload: any, okMessage: string) {
    this.savingIntegrations = true;
    this.saveMessage = '';
    try {
      await firstValueFrom(this.api.saveIntegrations(payload));
      this.saveOk = true;
      this.saveMessage = okMessage;
      this.loginForm.githubClientSecret = '';
      this.loginForm.gitlabClientSecret = '';
      this.integrations.githubToken = '';
      this.integrations.gitlabToken = '';
      this.integrations.clickupToken = '';
      await this.loadIntegrations();
    } catch (err: any) {
      this.saveOk = false;
      this.saveMessage = err.error?.error || err.message || 'Save failed';
      alert(this.saveMessage);
    } finally {
      this.savingIntegrations = false;
    }
  }

  async saveLogin() {
    await this.persistIntegrations({
      githubLoginEnabled: this.loginForm.githubLoginEnabled,
      githubClientId: this.loginForm.githubClientId,
      githubClientSecret: this.loginForm.githubClientSecret,
      gitlabLoginEnabled: this.loginForm.gitlabLoginEnabled,
      gitlabUrl: this.loginForm.gitlabUrl,
      gitlabClientId: this.loginForm.gitlabClientId,
      gitlabClientSecret: this.loginForm.gitlabClientSecret,
    }, 'Login configuration saved. GitHub / GitLab buttons appear on the login page once both client ID and secret are set.');
  }

  saveGitHubToken() {
    return this.persistIntegrations({
      githubToken: this.integrations.githubToken,
      githubOrg: this.integrations.githubOrg,
    }, 'GitHub linking token saved.');
  }

  saveGitLabToken() {
    return this.persistIntegrations({
      gitlabToken: this.integrations.gitlabToken,
      gitlabUrl: this.integrations.gitlabUrl,
      gitlabGroup: this.integrations.gitlabGroup,
    }, 'GitLab linking config saved.');
  }

  saveClickupConfig() {
    return this.persistIntegrations({
      clickupToken: this.integrations.clickupToken,
      clickupListId: this.integrations.clickupListId,
    }, 'ClickUp config saved.');
  }

  async rotateSecrets() {
    this.rotateError = '';
    this.rotateValues = null;
    this.rotateResults = [];
    if (this.rotateConfirm !== 'ROTATE') {
      this.rotateError = 'Type ROTATE to confirm.';
      return;
    }
    this.rotating = true;
    // Show step progress while the rotation request is running.
    const poll = setInterval(() => void this.loadLatestRotation(), 1500);
    // A retried request with the same key is replayed instead of rotating twice.
    const idempotencyKey = (globalThis.crypto as any)?.randomUUID?.() || `rotate-${Date.now()}-${Math.random()}`;
    try {
      const res: any = await this.stepUp.run(() => firstValueFrom(this.api.rotateSecrets('ROTATE', idempotencyKey)), 'Rotate platform secrets');
      this.rotateValues = res.values || null;
      this.rotateResults = res.results || [];
      if (res.operationId) this.rotationOperationId = res.operationId;
      this.rotateConfirm = '';
    } catch (err: any) {
      this.rotateError = err.status === 409
        ? 'Another secret rotation is already in progress.'
        : err.error?.error || err.message || 'Rotation failed';
      // The API may have restarted mid-rotation: show the (resumed) operation.
      void this.loadLatestRotation();
    } finally {
      clearInterval(poll);
      this.rotating = false;
    }
  }
}
