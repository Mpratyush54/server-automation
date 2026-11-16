import { StorageSettingsComponent } from './storage-settings.component';
import { UsageSettingsComponent } from './usage-settings.component';
import { LicenseSettingsComponent } from './license-settings.component';
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
import { ToastService, DialogService, errorText } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, OperationProgressComponent, GitConnectComponent, StorageSettingsComponent, UsageSettingsComponent, LicenseSettingsComponent],
  styleUrl: './settings.component.css',
  template: `
<div class="page-header">
  <div>
    <h1 class="page-title">Settings</h1>
    <p class="page-subtitle">How people sign in, how Cairn reaches your code, and where it sends email and stores files.</p>
  </div>
</div>

<nav class="subnav" aria-label="Settings sections">
  @if (isDevOps) {
    <button type="button" [class.active]="activeTab === 'login'" [attr.aria-current]="activeTab === 'login' ? 'page' : null" (click)="activeTab = 'login'">Sign-in</button>
  }
  <button type="button" [class.active]="activeTab === 'integrations'" [attr.aria-current]="activeTab === 'integrations' ? 'page' : null" (click)="activeTab = 'integrations'">Git linking</button>
  @if (isDevOps) {
    <button type="button" [class.active]="activeTab === 'smtp'" [attr.aria-current]="activeTab === 'smtp' ? 'page' : null" (click)="activeTab = 'smtp'">Email</button>
    <button type="button" [class.active]="activeTab === 'storage'" [attr.aria-current]="activeTab === 'storage' ? 'page' : null" (click)="activeTab = 'storage'">Storage</button>
    <button type="button" [class.active]="activeTab === 'usage'" [attr.aria-current]="activeTab === 'usage' ? 'page' : null" (click)="activeTab = 'usage'">Usage and costs</button>
    <button type="button" [class.active]="activeTab === 'rotate'" [attr.aria-current]="activeTab === 'rotate' ? 'page' : null" (click)="activeTab = 'rotate'">Rotate passwords</button>
    <button type="button" [class.active]="activeTab === 'security'" [attr.aria-current]="activeTab === 'security' ? 'page' : null" (click)="activeTab = 'security'">Security</button>
  }
  @if (isAdmin) {
    <button type="button" [class.active]="activeTab === 'license'" [attr.aria-current]="activeTab === 'license' ? 'page' : null" (click)="activeTab = 'license'">License</button>
  }
</nav>

<!-- Sign-in -->
@if (activeTab === 'login' && isDevOps) {
  <app-git-connect [isAdmin]="isAdmin"></app-git-connect>

  <details class="card card-flush st-disclosure">
    <summary>
      <span class="st-disclosure-title">Advanced: set up sign-in by hand</span>
      <span class="st-disclosure-hint">Only if one-click connect can't reach your Git provider.</span>
    </summary>
    <div class="st-rows">
      <h3 class="st-group">GitHub</h3>
      <div class="st-row">
        <div class="st-label">
          <label for="ghLogin">Sign in with GitHub</label>
          <p>Shows the button on the login page.</p>
        </div>
        <div class="st-field">
          <label class="st-check st-check-inline"><input type="checkbox" id="ghLogin" [(ngModel)]="loginForm.githubLoginEnabled"> Show the button</label>
          <span class="status" [class.status-ok]="providers.github?.enabled">{{ providers.github?.enabled ? 'Live' : 'Needs client ID and secret' }}</span>
        </div>
      </div>
      <div class="st-row">
        <div class="st-label">
          <label for="st-gh-client">Client ID and secret</label>
          <p>From the OAuth app you created on GitHub.</p>
        </div>
        <div class="st-field">
          <input id="st-gh-client" [(ngModel)]="loginForm.githubClientId" placeholder="Client ID, e.g. Ov23li…" autocomplete="off" aria-label="Client ID">
          <input id="st-gh-secret" type="password" [(ngModel)]="loginForm.githubClientSecret" [placeholder]="loginHints.githubClientSecret?.hint || 'Client secret'" autocomplete="off" aria-label="Client secret">
          <span class="form-hint">{{ loginHints.githubClientSecret?.set ? 'A secret is saved. Leave it empty to keep it.' : 'Both are needed to turn sign-in on.' }}</span>
        </div>
      </div>
      <div class="st-row">
        <div class="st-label">
          <label for="st-gh-callback">Callback URL</label>
          <p>Paste this into the OAuth app on GitHub.</p>
        </div>
        <div class="st-field">
          <input id="st-gh-callback" class="mono st-readonly" [value]="callbackUrls.github" [readonly]="true">
        </div>
      </div>

      <h3 class="st-group">GitLab</h3>
      <div class="st-row">
        <div class="st-label">
          <label for="glLogin">Sign in with GitLab</label>
          <p>Shows the button on the login page.</p>
        </div>
        <div class="st-field">
          <label class="st-check st-check-inline"><input type="checkbox" id="glLogin" [(ngModel)]="loginForm.gitlabLoginEnabled"> Show the button</label>
          <span class="status" [class.status-ok]="providers.gitlab?.enabled">{{ providers.gitlab?.enabled ? 'Live' : 'Needs application ID and secret' }}</span>
        </div>
      </div>
      <div class="st-row">
        <div class="st-label">
          <label for="st-gl-url">GitLab address</label>
          <p>Use gitlab.com or your own GitLab server.</p>
        </div>
        <div class="st-field">
          <input id="st-gl-url" [(ngModel)]="loginForm.gitlabUrl" placeholder="https://gitlab.com">
        </div>
      </div>
      <div class="st-row">
        <div class="st-label">
          <label for="st-gl-client">Application ID and secret</label>
          <p>From the application you created on GitLab.</p>
        </div>
        <div class="st-field">
          <input id="st-gl-client" [(ngModel)]="loginForm.gitlabClientId" placeholder="Application ID" autocomplete="off" aria-label="Application ID">
          <input id="st-gl-secret" type="password" [(ngModel)]="loginForm.gitlabClientSecret" [placeholder]="loginHints.gitlabClientSecret?.hint || 'Application secret'" autocomplete="off" aria-label="Application secret">
          <span class="form-hint">{{ loginHints.gitlabClientSecret?.set ? 'A secret is saved. Leave it empty to keep it.' : 'Both are needed to turn sign-in on.' }}</span>
        </div>
      </div>
      <div class="st-row">
        <div class="st-label">
          <label for="st-gl-callback">Redirect URI</label>
          <p>Paste this into the application on GitLab.</p>
        </div>
        <div class="st-field">
          <input id="st-gl-callback" class="mono st-readonly" [value]="callbackUrls.gitlab" [readonly]="true">
        </div>
      </div>
    </div>
    <div class="st-footer">
      @if (saveMessage) {
        <span class="st-msg st-footer-msg" [class.st-ok]="saveOk" [class.st-err]="!saveOk" role="status">{{ saveMessage }}</span>
      }
      <a class="st-learn" href="https://platform.pratyushes.dev/docs/guides/git-providers" target="_blank" rel="noopener">Learn more</a>
      <button type="button" class="btn btn-primary" (click)="saveLogin()" [disabled]="savingIntegrations">{{ savingIntegrations ? 'Saving…' : 'Save sign-in settings' }}</button>
    </div>
  </details>
}

<!-- Email -->
@if (activeTab === 'smtp' && isDevOps) {
  @if (smtpConfigs.length || !showSmtpForm) {
  <section class="card card-flush st-section" aria-labelledby="st-smtp-list">
    <div class="card-header">
      <h2 id="st-smtp-list">Mail servers</h2>
      @if (smtpConfigs.length && !showSmtpForm) {
        <button type="button" class="btn btn-sm btn-primary" (click)="showSmtpForm = true">Add mail server</button>
      }
    </div>
    @if (smtpConfigs.length === 0 && !showSmtpForm) {
      <div class="st-empty">
        <strong>No mail server yet</strong>
        <span>Cairn needs one to send invitations, password resets and alerts by email.</span>
        <button type="button" class="btn btn-primary btn-sm" (click)="showSmtpForm = true">Add mail server</button>
      </div>
    } @else if (smtpConfigs.length) {
      <ul class="st-list">
        @for (s of smtpConfigs; track s) {
          <li>
            <div class="st-item-head">
              <div class="st-item-main">
                <span class="st-item-tags">
                  <span class="st-item-name">{{ s.name }}</span>
                  @if (s.isDefault) { <span class="badge badge-active">Default</span> }
                </span>
                <span class="st-item-meta">{{ s.provider | uppercase }} · <span class="mono">{{ s.fromEmail }}</span></span>
              </div>
              <div class="st-item-actions">
                <button type="button" class="btn btn-sm" (click)="testSmtp(s)">Send test</button>
                <button type="button" class="btn btn-sm btn-ghost st-danger-text" (click)="deleteSmtp(s.id)">Delete</button>
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
  }

  @if (showSmtpForm) {
    <section class="card card-flush st-section" aria-labelledby="st-smtp-add">
      <div class="card-header"><h2 id="st-smtp-add">Add a mail server</h2></div>
      <div class="st-rows">
        <div class="st-row">
          <div class="st-label">
            <label for="st-smtp-provider">Service</label>
            <p>Who delivers the email.</p>
          </div>
          <div class="st-field">
            <select id="st-smtp-provider" [(ngModel)]="newSmtp.provider">
              <option value="custom">Any SMTP server</option>
              <option value="ses">AWS SES</option>
              <option value="sendgrid">SendGrid</option>
              <option value="mailgun">Mailgun</option>
            </select>
            <input id="st-smtp-name" [(ngModel)]="newSmtp.name" placeholder="Name, e.g. Production SES" aria-label="Name">
          </div>
        </div>
        @if (newSmtp.provider === 'custom' || newSmtp.provider === 'ses') {
          <div class="st-row">
            <div class="st-label">
              <label for="st-smtp-host">{{ newSmtp.provider === 'ses' ? 'Region' : 'Server' }}</label>
              <p>{{ newSmtp.provider === 'ses' ? 'The AWS region your SES account uses.' : 'Host name and port of the mail server.' }}</p>
            </div>
            <div class="st-field st-field-inline">
              <input id="st-smtp-host" [(ngModel)]="newSmtp.host" [placeholder]="newSmtp.provider === 'ses' ? 'us-east-1' : 'smtp.example.com'">
              @if (newSmtp.provider === 'custom') {
                <input id="st-smtp-port" class="st-port" type="number" [(ngModel)]="newSmtp.port" placeholder="587" aria-label="Port">
              }
            </div>
          </div>
        }
        <div class="st-row">
          <div class="st-label">
            <label for="st-smtp-pass">Credentials</label>
            <p>Stored encrypted.</p>
          </div>
          <div class="st-field">
            @if (newSmtp.provider !== 'sendgrid') {
              <input id="st-smtp-user" [(ngModel)]="newSmtp.username" placeholder="Username or access key" autocomplete="off" aria-label="Username or access key">
            }
            <input id="st-smtp-pass" type="password" [(ngModel)]="newSmtp.password" [placeholder]="newSmtp.provider === 'sendgrid' || newSmtp.provider === 'mailgun' ? 'API key' : 'Password or secret'" autocomplete="new-password">
          </div>
        </div>
        <div class="st-row">
          <div class="st-label">
            <label for="st-smtp-from">Sender</label>
            <p>What people see in the From line.</p>
          </div>
          <div class="st-field">
            <input id="st-smtp-from" [(ngModel)]="newSmtp.fromEmail" placeholder="noreply@yourdomain.com">
            <input id="st-smtp-fromname" [(ngModel)]="newSmtp.fromName" placeholder="Name (optional), e.g. Cairn" aria-label="Sender name">
            <label class="st-check st-check-inline"><input type="checkbox" id="smtpDefault" [(ngModel)]="newSmtp.isDefault"> Use this server by default</label>
          </div>
        </div>
      </div>
      <div class="st-footer">
        <a class="st-learn" href="https://platform.pratyushes.dev/docs/operations/alerting" target="_blank" rel="noopener">Learn more</a>
        <button type="button" class="btn btn-ghost" (click)="showSmtpForm = false">Cancel</button>
        <button type="button" class="btn btn-primary" (click)="saveSmtp()">Save mail server</button>
      </div>
    </section>
  }
}

<!-- Storage -->
@if (activeTab === 'storage' && isDevOps) { <app-storage-settings /> }

@if (activeTab === 'usage' && isDevOps) { <app-usage-settings /> }

@if (activeTab === 'license' && isAdmin) { <app-license-settings /> }

<!-- Git access -->
@if (activeTab === 'integrations') {
  <section class="card card-flush st-section" aria-labelledby="st-gh-link">
    <div class="card-header"><h2 id="st-gh-link">GitHub token</h2></div>
    <div class="st-rows">
      @if (isDevOps || isTechLeadOrDevOps) {
        <div class="st-row">
          <div class="st-label">
            <label for="st-gh-token">Personal access token</label>
            <p>Lets Cairn read branches and pull code. Not needed if the GitHub App is connected.</p>
          </div>
          <div class="st-field">
            <input id="st-gh-token" type="password" [(ngModel)]="integrations.githubToken" [placeholder]="loginHints.githubToken?.set ? 'Saved. Leave empty to keep it.' : 'ghp_…'" autocomplete="off">
            <span class="form-hint">Sign-in is set up on the Sign-in tab.</span>
          </div>
        </div>
        <div class="st-row">
          <div class="st-label">
            <label for="st-gh-org">Default organization</label>
            <p>Optional. Used when you pick repositories.</p>
          </div>
          <div class="st-field">
            <input id="st-gh-org" [(ngModel)]="integrations.githubOrg" placeholder="my-org">
          </div>
        </div>
      }
      <div class="st-row">
        <div class="st-label">
          <label for="st-gh-webhook">Webhook</label>
          <p>GitHub calls this address on every push so Cairn can deploy.</p>
        </div>
        <div class="st-field">
          <input id="st-gh-webhook" class="mono st-readonly" [value]="apiBase + '/webhooks/github'" [readonly]="true" aria-label="Webhook address">
          <span class="form-hint">Secret: <span class="mono">{{ loginHints.webhookSecret?.hint || 'Not set' }}</span></span>
        </div>
      </div>
    </div>
    @if (isDevOps || isTechLeadOrDevOps) {
      <div class="st-footer">
        <a class="st-learn" href="https://platform.pratyushes.dev/docs/guides/git-providers" target="_blank" rel="noopener">Learn more</a>
        <button type="button" class="btn btn-primary" (click)="saveGitHubToken()" [disabled]="savingIntegrations">Save</button>
      </div>
    }
  </section>

  <section class="card card-flush st-section" aria-labelledby="st-gl-link">
    <div class="card-header"><h2 id="st-gl-link">GitLab token</h2></div>
    <div class="st-rows">
      @if (isDevOps || isTechLeadOrDevOps) {
        <div class="st-row">
          <div class="st-label">
            <label for="st-gl-token">Personal access token</label>
            <p>Lets Cairn start pipelines and hear about merge requests.</p>
          </div>
          <div class="st-field">
            <input id="st-gl-token" type="password" [(ngModel)]="integrations.gitlabToken" [placeholder]="loginHints.gitlabToken?.set ? 'Saved. Leave empty to keep it.' : 'glpat-…'" autocomplete="off">
          </div>
        </div>
        <div class="st-row">
          <div class="st-label">
            <label for="st-gl-instance">GitLab address and group</label>
            <p>Group is optional and used when you pick repositories.</p>
          </div>
          <div class="st-field">
            <input id="st-gl-instance" [(ngModel)]="integrations.gitlabUrl" placeholder="https://gitlab.com" aria-label="GitLab address">
            <input id="st-gl-group" [(ngModel)]="integrations.gitlabGroup" placeholder="Default group, e.g. my-group" aria-label="Default group">
          </div>
        </div>
      }
      <div class="st-row">
        <div class="st-label">
          <label for="st-gl-webhook">Webhook</label>
          <p>GitLab calls this address on every push.</p>
        </div>
        <div class="st-field">
          <input id="st-gl-webhook" class="mono st-readonly" [value]="apiBase + '/webhooks/gitlab'" [readonly]="true">
        </div>
      </div>
    </div>
    @if (isDevOps || isTechLeadOrDevOps) {
      <div class="st-footer">
        <button type="button" class="btn btn-primary" (click)="saveGitLabToken()" [disabled]="savingIntegrations">Save</button>
      </div>
    }
  </section>

  <section class="card card-flush st-section" aria-labelledby="st-clickup">
    <div class="card-header"><h2 id="st-clickup">ClickUp</h2></div>
    <div class="st-rows">
      @if (isDevOps || isTechLeadOrDevOps) {
        <div class="st-row">
          <div class="st-label">
            <label for="st-cu-token">API token</label>
            <p>Links tasks to branches and updates them when a build finishes.</p>
          </div>
          <div class="st-field">
            <input id="st-cu-token" type="password" [(ngModel)]="integrations.clickupToken" [placeholder]="loginHints.clickupToken?.set ? 'Saved. Leave empty to keep it.' : 'pk_…'" autocomplete="off">
          </div>
        </div>
      }
      <div class="st-row">
        <div class="st-label">
          <label for="st-cu-list">Default list ID</label>
          <p>New tasks go to this list.</p>
        </div>
        <div class="st-field">
          <input id="st-cu-list" [(ngModel)]="integrations.clickupListId" [readonly]="!isDevOps && !isTechLeadOrDevOps" placeholder="901234567890">
        </div>
      </div>
    </div>
    @if (isDevOps || isTechLeadOrDevOps) {
      <div class="st-footer">
        <button type="button" class="btn btn-primary" (click)="saveClickupConfig()" [disabled]="savingIntegrations">Save</button>
      </div>
    }
  </section>
  @if (saveMessage) {
    <p class="st-msg" [class.st-ok]="saveOk" [class.st-err]="!saveOk" role="status">{{ saveMessage }}</p>
  }
}

<!-- Security -->
@if (activeTab === 'security' && isDevOps) {
  <section class="card card-flush st-section mfa-policy" aria-labelledby="st-mfa">
    <div class="card-header"><h2 id="st-mfa">Two-factor sign-in</h2></div>
    <div class="st-rows">
      <div class="st-row">
        <div class="st-label">
          <span class="st-label-text">Required for</span>
          <p>These roles must set up an authenticator app before they can use Cairn.</p>
        </div>
        <div class="st-field">
          <fieldset class="st-roles">
            <legend class="st-sr-only">Roles that require two-factor sign-in</legend>
            @for (r of allRoles; track r) {
              <label><input type="checkbox" [checked]="mfaRoles.includes(r)" (change)="toggleMfaRole(r)" [disabled]="!isAdmin"> {{ r }}</label>
            }
          </fieldset>
          <span class="form-hint">Revealing secrets, rotating passwords and creating agent tokens always ask for a code.@if (mfaPolicySource) { Set by: {{ mfaPolicySource }}. }</span>
        </div>
      </div>
    </div>
    <div class="st-footer">
      @if (mfaPolicyMessage) {
        <span class="st-msg st-footer-msg" role="status">{{ mfaPolicyMessage }}</span>
      }
      @if (!isAdmin) { <span class="muted">Only admins can change this.</span> }
      <a class="st-learn" href="https://platform.pratyushes.dev/docs/guides/mfa" target="_blank" rel="noopener">Learn more</a>
      @if (isAdmin) {
        <button type="button" class="btn btn-primary" (click)="saveMfaPolicy()" [disabled]="savingMfaPolicy">Save</button>
      }
    </div>
  </section>

  <section class="card card-flush st-section" aria-labelledby="st-backups-title">
    <div class="card-header">
      <h2 id="st-backups-title">Recovery backups</h2>
      <button type="button" class="btn btn-sm btn-ghost" (click)="loadBackups()">Refresh</button>
    </div>
    @if (backupError) {
      <p class="st-body st-msg st-err">{{ backupError }}</p>
    }
    @if (backupOverview?.storage?.localOnly) {
      <p class="st-body st-msg st-warn-text" role="alert">
        Backups are stored only on this server. If the server or its disk is lost, the backups are lost too.
        <a href="/docs/operations/backups">Set up off-site backups</a>
      </p>
    }
    @if (backupOverview) {
      <ul class="st-backups" aria-label="Where backups are stored">
        <li>
          <span class="st-backups-label">Stored in</span>
          @if (backupOverview.storage?.target; as target) {
            <span class="status status-ok">Off-site</span>
            <span class="secondary">{{ target.endpoint || target.endpointHost }}/{{ target.bucket }}{{ target.prefix ? '/' + target.prefix : '' }}</span>
          } @else {
            <span class="status status-warn">This server only</span>
          }
        </li>
        @if (backupOverview.postgres?.engine === 'cnpg') {
          <li>
            <span class="st-backups-label">Database change log</span>
            <span class="status" [ngClass]="backupOverview.postgres.archiving === 'ok' ? 'status-ok' : backupOverview.postgres.archiving === 'failing' ? 'status-down' : 'status-warn'">{{ archiveWord(backupOverview.postgres.archiving) }}</span>
            @if (backupOverview.postgres.lastArchivedWalAt) {
              <span class="secondary">last saved {{ backupOverview.postgres.lastArchivedWalAt | date:'medium' }}</span>
            }
          </li>
          <li>
            <span class="st-backups-label">Last database snapshot</span>
            @if (backupOverview.postgres.lastBaseBackupAt) {
              <span class="secondary">{{ backupOverview.postgres.lastBaseBackupAt | date:'medium' }}</span>
            } @else {
              <span class="muted">None yet</span>
            }
          </li>
          <li>
            <span class="st-backups-label">Restore to any moment</span>
            @if (backupOverview.postgres.recoveryWindow?.from) {
              <span class="secondary">from {{ backupOverview.postgres.recoveryWindow.from | date:'medium' }} to {{ backupOverview.postgres.recoveryWindow.to | date:'medium' }}</span>
            } @else {
              <span class="muted">Available after the first database snapshot</span>
            }
          </li>
        } @else if (backupOverview.postgres?.engine === 'bitnami') {
          <li>
            <span class="st-backups-label">Restore to any moment</span>
            <span class="muted">Not available yet. On the server run <code>sudo platformctl postgres migrate --confirm</code></span>
          </li>
        }
        <li>
          <span class="st-backups-label">Last full backup</span>
          @if (backupOverview.lastFullBackupAt) {
            <span class="secondary">{{ backupOverview.lastFullBackupAt | date:'medium' }}</span>
          } @else {
            <span class="muted">None yet</span>
          }
        </li>
      </ul>
    }
    @if (backupStatus.length) {
      <ul class="st-backups">
        @for (item of backupStatus; track item.operation) {
          <li>
            <span class="st-backups-label">{{ item.operation === 'backup' ? 'Latest backup' : 'Latest restore test' }}</span>
            @if (item.status) {
              <span class="status" [ngClass]="item.status.success ? 'status-ok' : 'status-down'">{{ item.status.success ? 'Passed' : 'Failed' }}</span>
              <span class="secondary">{{ item.status.finishedAt | date:'medium' }}</span>
              <span class="muted">{{ formatBytes(item.status.bytes) }} in {{ item.status.durationSeconds | number:'1.0-0' }} s</span>
            } @else {
              <span class="muted">No result yet</span>
            }
          </li>
        }
      </ul>
    } @else if (!backupError) {
      <div class="st-empty">
        <strong>No backup results yet</strong>
        <span>Cairn backs up its own data every night and tests a restore. Results show here after the first run.</span>
      </div>
    }
  </section>
}

<!-- Rotate passwords -->
@if (activeTab === 'rotate' && isDevOps) {
  <section class="card card-flush st-section" aria-labelledby="st-rotate">
    <div class="card-header"><h2 id="st-rotate">Rotate passwords</h2></div>
    <div class="st-rows">
      <div class="st-row">
        <div class="st-label">
          <label for="st-rotate-confirm">Confirm</label>
          <p>Replaces Cairn's internal passwords with new ones. Running apps keep working.</p>
        </div>
        <div class="st-field">
          <input id="st-rotate-confirm" class="mono" [(ngModel)]="rotateConfirm" placeholder="Type ROTATE" autocomplete="off">
          <span class="form-hint">New values are shown <strong>once</strong>. Copy them into a password manager. If this page loses them, read the admin password on the server: <code>sudo platformctl update</code>, then <code>sudo cat /etc/platform/credentials/admin</code>.</span>
          <details class="st-details">
            <summary>What gets rotated</summary>
            <p class="st-note">The admin account, the database, the cache, the webhook secret and the deploy tool. If a service rejects the new password, Cairn retries and fixes it without SSH. MongoDB, file storage (MinIO), Portainer and the sign-in key (JWT) are left unchanged.</p>
          </details>
        </div>
      </div>
    </div>
    <div class="st-footer">
      <a class="st-learn" href="https://platform.pratyushes.dev/docs/deployment/update-secrets" target="_blank" rel="noopener">Learn more</a>
      <button type="button" class="btn btn-danger" (click)="rotateSecrets()" [disabled]="rotating || rotateConfirm !== 'ROTATE'">{{ rotating ? 'Rotating…' : 'Rotate passwords' }}</button>
    </div>
    @if (rotateError || rotationOperationId || rotateValues || rotateResults.length) {
      <div class="st-body st-rotate-out">
        @if (rotateError) {
          <p class="st-msg st-err" role="alert">{{ rotateError }}</p>
          @if (rotateAnswerLost) {
            <p class="st-note">The rotation may still have finished. The new admin password is saved on the cluster. To read it, run <code>sudo platformctl update</code> on the server, then <code>sudo cat /etc/platform/credentials/admin</code>. Check the progress below before you rotate again.</p>
          }
        }
        @if (rotationOperationId) {
          <app-operation-progress [operationId]="rotationOperationId" title="Password rotation"></app-operation-progress>
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
    }
  </section>
}
`
})
export class SettingsComponent implements OnInit {
  activeTab = 'login';
  /** Email tab: show the add-mail-server form. */
  showSmtpForm = false;
  backupStatus: any[] = [];
  /** Where backups go and the PostgreSQL recovery window (#186). */
  backupOverview: any = null;
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
  /** The request failed without an answer (gateway timeout, lost connection): values may exist only on the cluster. */
  rotateAnswerLost = false;
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

  private toast = inject(ToastService);
  private dialog = inject(DialogService);

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
      const p: any = await this.stepUp.run(() => firstValueFrom(this.mfa.setPolicy(this.mfaRoles)), 'Change two-factor sign-in rules');
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
      if (tab && (tab === 'integrations' || (this.isDevOps && ['login', 'smtp', 'storage', 'usage', 'rotate', 'security'].includes(tab)) || (this.isAdmin && tab === 'license'))) {
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

  /** Backup size in a readable unit (B, KB, MB, GB). */
  formatBytes(n: number | null | undefined): string {
    if (n == null || isNaN(n)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    return `${i ? v.toFixed(1) : v} ${units[i]}`;
  }

  async loadBackups() {
    try {
      const res = await firstValueFrom(this.api.getBackupStatus());
      this.backupStatus = res?.items ?? [];
      this.backupOverview = res?.storage ? res : null;
      this.backupError = '';
    } catch { this.backupError = 'Backup status unavailable. Check the backup jobs and cluster access.'; }
  }

  archiveWord(state: string): string {
    return state === 'ok' ? 'Working' : state === 'failing' ? 'Failing' : state === 'not-configured' ? 'Not set up' : 'Unknown';
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
    try { this.smtpConfigs = (await firstValueFrom(this.api.getSmtpConfigs())) ?? []; } catch { this.smtpConfigs = []; }
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
      this.showSmtpForm = false;
      this.toast.ok('Mail server saved');
    } catch (err: any) { this.toast.error('Mail server was not saved: ' + errorText(err)); }
  }

  async testSmtp(s: any) {
    try {
      const res = await firstValueFrom(this.api.testSmtpConfig(s.id, s.fromEmail));
      this.testResults[s.id] = res;
    } catch (err: any) { this.testResults[s.id] = { success: false, error: err.error?.error || err.message }; }
  }

  async deleteSmtp(id: string) {
    const ok = await this.dialog.confirm({
      title: 'Remove this mail server?',
      message: 'Cairn stops sending email through it. Add it again to restore it.',
      confirmLabel: 'Remove mail server',
      danger: true,
    });
    if (!ok) return;
    await firstValueFrom(this.api.deleteSmtpConfig(id));
    await this.loadSmtp();
  }

  async saveStorage() {
    try {
      await firstValueFrom(this.api.createStorageProvider(this.newStorage));
      this.newStorage = { name: '', providerType: 'minio', endpointUrl: '', bucketName: '', isDefault: false, credentials: {} };
      await this.loadStorage();
      this.toast.ok('Storage provider saved');
    } catch (err: any) { this.toast.error('Storage provider was not saved: ' + errorText(err)); }
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
    const ok = await this.dialog.confirm({
      title: 'Remove this storage provider?',
      message: 'Cairn stops using it for backups and uploads. Files already stored in it are not deleted.',
      confirmLabel: 'Remove provider',
      danger: true,
    });
    if (!ok) return;
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
      this.toast.error('Settings were not saved: ' + this.saveMessage);
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
    }, 'Sign-in settings saved. The buttons appear on the login page once both ID and secret are set.');
  }

  saveGitHubToken() {
    return this.persistIntegrations({
      githubToken: this.integrations.githubToken,
      githubOrg: this.integrations.githubOrg,
    }, 'GitHub token saved.');
  }

  saveGitLabToken() {
    return this.persistIntegrations({
      gitlabToken: this.integrations.gitlabToken,
      gitlabUrl: this.integrations.gitlabUrl,
      gitlabGroup: this.integrations.gitlabGroup,
    }, 'GitLab settings saved.');
  }

  saveClickupConfig() {
    return this.persistIntegrations({
      clickupToken: this.integrations.clickupToken,
      clickupListId: this.integrations.clickupListId,
    }, 'ClickUp settings saved.');
  }

  async rotateSecrets() {
    this.rotateError = '';
    this.rotateAnswerLost = false;
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
      const res: any = await this.stepUp.run(() => firstValueFrom(this.api.rotateSecrets('ROTATE', idempotencyKey)), 'Rotate passwords');
      this.rotateValues = res.values || null;
      this.rotateResults = res.results || [];
      if (res.operationId) this.rotationOperationId = res.operationId;
      this.rotateConfirm = '';
    } catch (err: any) {
      this.rotateError = err.status === 409
        ? 'Another secret rotation is already in progress.'
        : err.error?.error || err.message || 'Rotation failed';
      this.rotateAnswerLost = !err.status || err.status >= 500;
      // The API may have restarted mid-rotation: show the (resumed) operation.
      void this.loadLatestRotation();
    } finally {
      clearInterval(poll);
      this.rotating = false;
    }
  }
}
