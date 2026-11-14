import { StorageSettingsComponent } from './storage-settings.component';
import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';
import { MfaService } from '../../services/mfa.service';
import { OperationProgressComponent } from '../../shared/operation-progress.component';
import { GitConnectComponent } from './git-connect.component';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, OperationProgressComponent, GitConnectComponent, StorageSettingsComponent],
  styleUrl: './settings.component.css',
  template: `
<div class="page-header">
  <div>
    <h1 class="page-title">Settings</h1>
    <p class="page-subtitle">Sign-in providers, Git access, email, storage and security for this platform.</p>
  </div>
</div>

@if (isDevOps) {
  <section class="card card-flush st-section" aria-labelledby="st-backups-title">
    <div class="card-header">
      <h2 id="st-backups-title">Disaster recovery backups</h2>
      <button type="button" class="btn btn-sm" (click)="loadBackups()">Refresh</button>
    </div>
    @if (backupError) {
      <p class="st-body st-msg st-err">{{ backupError }}</p>
    }
    @if (backupStatus.length) {
      <ul class="st-backups">
        @for (item of backupStatus; track item.operation) {
          <li>
            <span class="st-backups-label">{{ item.operation === 'backup' ? 'Latest backup' : 'Latest restore test' }}</span>
            @if (item.status) {
              <span class="status" [ngClass]="item.status.success ? 'status-ok' : 'status-down'">{{ item.status.success ? 'Passed' : 'Failed' }}</span>
              <span class="secondary">{{ item.status.finishedAt | date:'medium' }}</span>
              <span class="muted">{{ item.status.bytes | number }} bytes, {{ item.status.durationSeconds | number:'1.0-1' }} seconds</span>
            } @else {
              <span class="muted">No result reported yet</span>
            }
          </li>
        }
      </ul>
    } @else if (!backupError) {
      <p class="st-empty">No backup results yet.</p>
    }
  </section>
}

<nav class="subnav" aria-label="Settings sections">
  @if (isDevOps) {
    <button type="button" [class.active]="activeTab === 'login'" [attr.aria-current]="activeTab === 'login' ? 'page' : null" (click)="activeTab = 'login'">Sign-in</button>
  }
  <button type="button" [class.active]="activeTab === 'integrations'" [attr.aria-current]="activeTab === 'integrations' ? 'page' : null" (click)="activeTab = 'integrations'">Git linking</button>
  @if (isDevOps) {
    <button type="button" [class.active]="activeTab === 'smtp'" [attr.aria-current]="activeTab === 'smtp' ? 'page' : null" (click)="activeTab = 'smtp'">Email</button>
    <button type="button" [class.active]="activeTab === 'storage'" [attr.aria-current]="activeTab === 'storage' ? 'page' : null" (click)="activeTab = 'storage'">Storage</button>
    <button type="button" [class.active]="activeTab === 'rotate'" [attr.aria-current]="activeTab === 'rotate' ? 'page' : null" (click)="activeTab = 'rotate'">Rotate secrets</button>
    <button type="button" [class.active]="activeTab === 'security'" [attr.aria-current]="activeTab === 'security' ? 'page' : null" (click)="activeTab = 'security'">Security</button>
  }
</nav>

<!-- Sign-in -->
@if (activeTab === 'login' && isDevOps) {
  <app-git-connect [isAdmin]="isAdmin"></app-git-connect>
  <p class="st-intro">Use this when one-click connect is not possible. Create a GitHub OAuth app or a GitLab application, paste its client ID and secret here, and the sign-in button appears on the login page. Callback URLs must match exactly.</p>
  <div class="st-grid">
    <section class="card card-flush" aria-labelledby="st-gh-login">
      <div class="card-header">
        <h2 id="st-gh-login">GitHub OAuth sign-in</h2>
        <span class="status" [class.status-ok]="providers.github?.enabled">{{ providers.github?.enabled ? 'Live' : 'Not ready' }}</span>
      </div>
      <div class="st-body">
        <label class="st-check"><input type="checkbox" id="ghLogin" [(ngModel)]="loginForm.githubLoginEnabled"> Show "Sign in with GitHub"</label>
        <div class="form-group">
          <label for="st-gh-client">Client ID</label>
          <input id="st-gh-client" [(ngModel)]="loginForm.githubClientId" placeholder="Ov23li…" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="st-gh-secret">Client secret {{ loginHints.githubClientSecret?.set ? '(saved)' : '' }}</label>
          <input id="st-gh-secret" type="password" [(ngModel)]="loginForm.githubClientSecret" [placeholder]="loginHints.githubClientSecret?.hint || 'Leave blank to keep current'" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="st-gh-callback">Authorization callback URL</label>
          <input id="st-gh-callback" class="mono st-readonly" [value]="callbackUrls.github" [readonly]="true">
        </div>
        @if (!providers.github?.enabled) {
          <p class="st-note">Add the client ID and secret to turn this on.</p>
        }
      </div>
    </section>
    <section class="card card-flush" aria-labelledby="st-gl-login">
      <div class="card-header">
        <h2 id="st-gl-login">GitLab OAuth sign-in</h2>
        <span class="status" [class.status-ok]="providers.gitlab?.enabled">{{ providers.gitlab?.enabled ? 'Live' : 'Not ready' }}</span>
      </div>
      <div class="st-body">
        <label class="st-check"><input type="checkbox" id="glLogin" [(ngModel)]="loginForm.gitlabLoginEnabled"> Show "Sign in with GitLab"</label>
        <div class="form-group">
          <label for="st-gl-url">GitLab URL</label>
          <input id="st-gl-url" [(ngModel)]="loginForm.gitlabUrl" placeholder="https://gitlab.com">
        </div>
        <div class="form-group">
          <label for="st-gl-client">Application ID</label>
          <input id="st-gl-client" [(ngModel)]="loginForm.gitlabClientId" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="st-gl-secret">Application secret {{ loginHints.gitlabClientSecret?.set ? '(saved)' : '' }}</label>
          <input id="st-gl-secret" type="password" [(ngModel)]="loginForm.gitlabClientSecret" [placeholder]="loginHints.gitlabClientSecret?.hint || 'Leave blank to keep current'" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="st-gl-callback">Redirect URI</label>
          <input id="st-gl-callback" class="mono st-readonly" [value]="callbackUrls.gitlab" [readonly]="true">
        </div>
        @if (!providers.gitlab?.enabled) {
          <p class="st-note">Add the application ID and secret to turn this on.</p>
        }
      </div>
    </section>
  </div>
  <div class="st-actions">
    <button type="button" class="btn btn-primary" (click)="saveLogin()" [disabled]="savingIntegrations">Save sign-in settings</button>
  </div>
  @if (saveMessage) {
    <p class="st-msg" [class.st-ok]="saveOk" [class.st-err]="!saveOk" role="status">{{ saveMessage }}</p>
  }
}

<!-- Email -->
@if (activeTab === 'smtp' && isDevOps) {
  <div class="st-grid">
    <section class="card card-flush" aria-labelledby="st-smtp-add">
      <div class="card-header"><h2 id="st-smtp-add">Add a mail server</h2></div>
      <div class="st-body">
        <div class="form-group">
          <label for="st-smtp-name">Label</label>
          <input id="st-smtp-name" [(ngModel)]="newSmtp.name" placeholder="Production SES">
        </div>
        <div class="form-group">
          <label for="st-smtp-provider">Provider</label>
          <select id="st-smtp-provider" [(ngModel)]="newSmtp.provider">
            <option value="custom">Custom SMTP</option>
            <option value="ses">AWS SES</option>
            <option value="sendgrid">SendGrid</option>
            <option value="mailgun">Mailgun</option>
          </select>
        </div>
        @if (newSmtp.provider === 'custom' || newSmtp.provider === 'ses') {
          <div class="form-group">
            <label for="st-smtp-host">SMTP host or region</label>
            <input id="st-smtp-host" [(ngModel)]="newSmtp.host" placeholder="smtp.example.com or us-east-1">
          </div>
        }
        @if (newSmtp.provider === 'custom') {
          <div class="form-group">
            <label for="st-smtp-port">Port</label>
            <input id="st-smtp-port" type="number" [(ngModel)]="newSmtp.port" placeholder="587">
          </div>
        }
        @if (newSmtp.provider !== 'sendgrid') {
          <div class="form-group">
            <label for="st-smtp-user">Username or access key</label>
            <input id="st-smtp-user" [(ngModel)]="newSmtp.username" placeholder="Username or access key" autocomplete="off">
          </div>
        }
        <div class="form-group">
          <label for="st-smtp-pass">{{ newSmtp.provider === 'sendgrid' || newSmtp.provider === 'mailgun' ? 'API key' : 'Password or secret' }}</label>
          <input id="st-smtp-pass" type="password" [(ngModel)]="newSmtp.password" placeholder="••••••••" autocomplete="new-password">
        </div>
        <div class="form-group">
          <label for="st-smtp-from">From address</label>
          <input id="st-smtp-from" [(ngModel)]="newSmtp.fromEmail" placeholder="noreply@yourdomain.com">
        </div>
        <div class="form-group">
          <label for="st-smtp-fromname">From name (optional)</label>
          <input id="st-smtp-fromname" [(ngModel)]="newSmtp.fromName" placeholder="Platform">
        </div>
        <label class="st-check"><input type="checkbox" id="smtpDefault" [(ngModel)]="newSmtp.isDefault"> Send platform email from this server by default</label>
        <div class="st-actions">
          <button type="button" class="btn btn-primary" (click)="saveSmtp()">Save mail server</button>
        </div>
      </div>
    </section>
    <section class="card card-flush" aria-labelledby="st-smtp-list">
      <div class="card-header"><h2 id="st-smtp-list">Mail servers</h2></div>
      @if (smtpConfigs.length === 0) {
        <p class="st-empty">No mail servers yet. Add one so the platform can send email notifications.</p>
      } @else {
        <ul class="st-list">
          @for (s of smtpConfigs; track s) {
            <li>
              <div class="st-item-head">
                <div class="st-item-main">
                  <span class="st-item-name">{{ s.name }}</span>
                  <span class="st-item-meta">{{ s.provider | uppercase }} · <span class="mono">{{ s.fromEmail }}</span></span>
                  @if (s.isDefault) {
                    <span class="st-item-tags"><span class="badge badge-active">Default</span></span>
                  }
                </div>
                <div class="st-item-actions">
                  <button type="button" class="btn btn-sm" (click)="testSmtp(s)">Send test</button>
                  <button type="button" class="btn btn-sm btn-danger" (click)="deleteSmtp(s.id)">Delete</button>
                </div>
              </div>
              @if (testResults[s.id]) {
                <p class="st-item-result">
                  @if (testResults[s.id].success) {
                    <span class="status status-ok">Test email sent</span>
                  } @else {
                    <span class="status status-down">Test failed</span> <span class="secondary">{{ testResults[s.id].error }}</span>
                  }
                </p>
              }
            </li>
          }
        </ul>
      }
    </section>
  </div>
}

<!-- Storage -->
@if (activeTab === 'storage' && isDevOps) { <app-storage-settings /> }

<!-- Git linking -->
@if (activeTab === 'integrations') {
  <div class="st-grid">
    <section class="card card-flush" aria-labelledby="st-gh-link">
      <div class="card-header"><h2 id="st-gh-link">GitHub linking</h2></div>
      <div class="st-body">
        <p class="st-intro">A personal access token the platform uses to list branches, register webhooks and pull repositories. Sign-in is configured on the Sign-in tab.</p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label for="st-gh-token">Personal access token {{ loginHints.githubToken?.set ? '(saved)' : '' }}</label>
            <input id="st-gh-token" type="password" [(ngModel)]="integrations.githubToken" placeholder="ghp_xxxx..." autocomplete="off">
          </div>
          <div class="form-group">
            <label for="st-gh-org">Default organization (optional)</label>
            <input id="st-gh-org" [(ngModel)]="integrations.githubOrg" placeholder="my-org">
          </div>
        }
        <div class="form-group">
          <label for="st-gh-webhook">Webhook secret</label>
          <input id="st-gh-webhook" class="mono st-readonly" [value]="loginHints.webhookSecret?.hint || 'Not set'" [readonly]="true">
        </div>
        <p class="st-note">Webhook URL: <span class="mono">{{ apiBase }}/webhooks/github</span></p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="st-actions">
            <button type="button" class="btn btn-primary btn-sm" (click)="saveGitHubToken()">Save GitHub token</button>
          </div>
        }
      </div>
    </section>
    <section class="card card-flush" aria-labelledby="st-gl-link">
      <div class="card-header"><h2 id="st-gl-link">GitLab linking</h2></div>
      <div class="st-body">
        <p class="st-intro">A personal access token the platform uses to trigger pipelines and receive merge request events.</p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label for="st-gl-token">Personal access token {{ loginHints.gitlabToken?.set ? '(saved)' : '' }}</label>
            <input id="st-gl-token" type="password" [(ngModel)]="integrations.gitlabToken" placeholder="glpat-xxxx..." autocomplete="off">
          </div>
          <div class="form-group">
            <label for="st-gl-instance">GitLab URL</label>
            <input id="st-gl-instance" [(ngModel)]="integrations.gitlabUrl" placeholder="https://gitlab.com">
          </div>
          <div class="form-group">
            <label for="st-gl-group">Default group (optional)</label>
            <input id="st-gl-group" [(ngModel)]="integrations.gitlabGroup" placeholder="my-group">
          </div>
        }
        <p class="st-note">Webhook URL: <span class="mono">{{ apiBase }}/webhooks/gitlab</span></p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="st-actions">
            <button type="button" class="btn btn-primary btn-sm" (click)="saveGitLabToken()">Save GitLab settings</button>
          </div>
        }
      </div>
    </section>
    <section class="card card-flush" aria-labelledby="st-clickup">
      <div class="card-header"><h2 id="st-clickup">ClickUp</h2></div>
      <div class="st-body">
        <p class="st-intro">Link ClickUp tasks to branches and commits, and update tasks when a pipeline changes state.</p>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="form-group">
            <label for="st-cu-token">API token {{ loginHints.clickupToken?.set ? '(saved)' : '' }}</label>
            <input id="st-cu-token" type="password" [(ngModel)]="integrations.clickupToken" placeholder="pk_xxxx..." autocomplete="off">
          </div>
        }
        <div class="form-group">
          <label for="st-cu-list">Default list ID</label>
          <input id="st-cu-list" [(ngModel)]="integrations.clickupListId" [readonly]="!isDevOps && !isTechLeadOrDevOps" placeholder="901234567890">
        </div>
        @if (isDevOps || isTechLeadOrDevOps) {
          <div class="st-actions">
            <button type="button" class="btn btn-primary btn-sm" (click)="saveClickupConfig()">Save ClickUp settings</button>
          </div>
        }
      </div>
    </section>
  </div>
  @if (saveMessage) {
    <p class="st-msg" [class.st-ok]="saveOk" [class.st-err]="!saveOk" role="status">{{ saveMessage }}</p>
  }
}

<!-- Security -->
@if (activeTab === 'security' && isDevOps) {
  <section class="card card-flush st-narrow mfa-policy" aria-labelledby="st-mfa">
    <div class="card-header"><h2 id="st-mfa">Two-factor authentication policy</h2></div>
    <div class="st-body">
      <p class="st-intro">People in these roles must set up an authenticator app before they can use the portal (setting <code>mfa.requiredRoles</code>). Revealing secrets, rotating platform secrets and creating agent tokens always ask for a recent code.</p>
      <fieldset class="st-roles">
        <legend class="st-sr-only">Roles that require two-factor authentication</legend>
        @for (r of allRoles; track r) {
          <label><input type="checkbox" [checked]="mfaRoles.includes(r)" (change)="toggleMfaRole(r)" [disabled]="!isAdmin"> {{ r }}</label>
        }
      </fieldset>
      @if (mfaPolicySource) {
        <p class="st-note">Source: {{ mfaPolicySource }}</p>
      }
      @if (isAdmin) {
        <div class="st-actions">
          <button type="button" class="btn btn-primary btn-sm" (click)="saveMfaPolicy()" [disabled]="savingMfaPolicy">Save policy</button>
        </div>
      } @else {
        <p class="st-note">Only admins can change the policy.</p>
      }
      @if (mfaPolicyMessage) {
        <p class="st-msg" role="status">{{ mfaPolicyMessage }}</p>
      }
    </div>
  </section>
}

<!-- Rotate secrets -->
@if (activeTab === 'rotate' && isDevOps) {
  <section class="card card-flush st-narrow" aria-labelledby="st-rotate">
    <div class="card-header"><h2 id="st-rotate">Rotate secrets</h2></div>
    <div class="st-body">
      <p class="st-intro">Rotates the credentials that can change while the platform runs: platform admin, PostgreSQL, Redis, the webhook secret and Argo CD. If PostgreSQL or Redis rejects the new password, the API retries every stored copy and syncs the Kubernetes secrets itself, so no SSH is needed. MongoDB, MinIO and Portainer are left as they are so the API does not restart with passwords those servers would reject. The JWT secret is not rotated.</p>
      <p class="st-callout">New values are shown <strong>once</strong>. Copy them into a password manager before you leave this page.</p>
      <div class="form-group">
        <label for="st-rotate-confirm">Type ROTATE to confirm</label>
        <input id="st-rotate-confirm" class="mono" [(ngModel)]="rotateConfirm" placeholder="ROTATE" autocomplete="off">
      </div>
      <div class="st-actions">
        <button type="button" class="btn btn-danger" (click)="rotateSecrets()" [disabled]="rotating || rotateConfirm !== 'ROTATE'">Rotate all secrets</button>
      </div>
      @if (rotateError) {
        <p class="st-msg st-err" role="alert">{{ rotateError }}</p>
      }
      @if (rotationOperationId) {
        <app-operation-progress [operationId]="rotationOperationId" title="Secret rotation"></app-operation-progress>
      }
      @if (rotateValues) {
        <h3 class="st-subhead">New values (copy now)</h3>
        <pre class="st-pre">{{ rotateValues | json }}</pre>
      }
      @if (rotateResults.length) {
        <ul class="st-results">
          @for (r of rotateResults; track r) {
            <li>
              <span class="status" [ngClass]="r.ok ? 'status-ok' : 'status-down'">{{ r.ok ? 'Rotated' : 'Failed' }}</span>
              <span class="mono">{{ r.key }}</span>
              <span class="st-result-detail">{{ r.detail }}</span>
            </li>
          }
        </ul>
      }
    </div>
  </section>
}
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
  private route = inject(ActivatedRoute, { optional: true });
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

    this.activeTab = this.isDevOps ? 'login' : 'integrations';
    // Deep link from global search: /settings?tab=<activeTab>, only tabs this role can see.
    this.route?.queryParamMap.subscribe((q) => {
      const tab = q.get('tab');
      if (tab && (tab === 'integrations' || (this.isDevOps && ['login', 'smtp', 'storage', 'rotate', 'security'].includes(tab)))) {
        this.activeTab = tab;
      }
    });

    if (this.isDevOps) {
      await Promise.all([this.loadSmtp(), this.loadStorage(), this.loadIntegrations(), this.loadBackups()]);
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
