import { Component, OnInit, inject } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { MfaService, MfaStatus, downloadRecoveryCodes } from '../../services/mfa.service';
import { MfaEnrollmentComponent } from '../../shared/mfa-enrollment.component';
import { DialogService } from '../../shared/feedback/feedback.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [FormsModule, MfaEnrollmentComponent],
  styleUrl: './profile.component.css',
  template: `
<div class="page-header">
  <div>
    <h1 class="page-title">Profile</h1>
    <p class="page-subtitle">Your account details, linked Git sign-ins, two-factor authentication and password.</p>
  </div>
</div>

@if (error) {
  <p class="pf-banner pf-banner-err" role="alert">{{ error }}</p>
}
@if (success) {
  <p class="pf-banner pf-banner-ok" role="status">{{ success }}</p>
}

<div class="pf-grid">
  <section class="card card-flush" aria-labelledby="pf-account">
    <div class="card-header"><h2 id="pf-account">Account</h2></div>
    <div class="pf-body">
      <div class="pf-identity">
        <div class="pf-avatar">
          @if (me.avatarUrl) {
            <img [src]="me.avatarUrl" alt="">
          }
          @if (!me.avatarUrl) {
            <span>{{ initials }}</span>
          }
        </div>
        <div class="pf-identity-text">
          <span class="pf-name">{{ me.name || '—' }}</span>
          <span class="mono pf-email">{{ me.email }}</span>
          @if (me.role) { <span><span class="badge">{{ me.role }}</span></span> }
        </div>
      </div>
      <div class="form-group">
        <label for="pf-name">Name</label>
        <input id="pf-name" [(ngModel)]="me.name">
      </div>
      <div class="form-group">
        <label for="pf-avatar">Avatar URL</label>
        <input id="pf-avatar" [(ngModel)]="me.avatarUrl" placeholder="https://…">
      </div>
      <div class="form-group">
        <label for="pf-email">Email</label>
        <input id="pf-email" class="pf-readonly" [value]="me.email" [readonly]="true">
      </div>
      <div class="form-group">
        <label for="pf-username">Username</label>
        <input id="pf-username" class="pf-readonly" [value]="me.username || '—'" [readonly]="true">
      </div>
      <div class="pf-actions">
        <button type="button" class="btn btn-primary" (click)="saveProfile()" [disabled]="saving">Save profile</button>
      </div>
    </div>
  </section>

  <div class="pf-stack">
    <section class="card card-flush" aria-labelledby="pf-linked">
      <div class="card-header"><h2 id="pf-linked">Linked sign-ins</h2></div>
      <div class="pf-body">
        <p class="pf-intro">An admin sets up GitHub and GitLab sign-in under Settings, Sign-in. When you sign in with either provider, that identity is linked here.</p>
      </div>
      <ul class="pf-list">
        <li>
          <span class="pf-list-name">GitHub</span>
          @if (me.githubId) {
            <span class="pf-list-value"><span class="status status-ok">Linked</span> <span class="mono muted">{{ me.githubId }}</span></span>
          } @else {
            <span class="status">Not linked</span>
          }
        </li>
        <li>
          <span class="pf-list-name">GitLab</span>
          @if (me.gitlabId) {
            <span class="pf-list-value"><span class="status status-ok">Linked</span> <span class="mono muted">{{ me.gitlabId }}</span></span>
          } @else {
            <span class="status">Not linked</span>
          }
        </li>
      </ul>
    </section>

    <section class="card card-flush mfa-card" aria-labelledby="pf-mfa">
      <div class="card-header">
        <h2 id="pf-mfa">Two-factor authentication</h2>
        @if (mfaStatus) {
          <span class="status" [class.status-ok]="mfaStatus.enabled" [class.status-warn]="!mfaStatus.enabled && mfaStatus.required">{{ mfaStatus.enabled ? 'On' : 'Off' }}</span>
        }
      </div>
      <div class="pf-body">
        @if (mfaStatus?.enabled) {
          <p class="mfa-on pf-intro">
            {{ mfaStatus!.recoveryCodesRemaining }} recovery code{{ mfaStatus!.recoveryCodesRemaining === 1 ? '' : 's' }} left.
            @if (mfaStatus!.required) { Required for your role ({{ me.role }}). }
          </p>
          @if (newRecoveryCodes.length) {
            <ul class="mfa-new-codes pf-codes mono">
              @for (c of newRecoveryCodes; track c) { <li>{{ c }}</li> }
            </ul>
            <div class="pf-actions pf-actions-tight">
              <button class="btn btn-sm" type="button" (click)="downloadCodes()">Download codes</button>
            </div>
          }
          <div class="form-group pf-code-field">
            <label for="pf-mfa-code">Current code (authenticator or recovery code)</label>
            <input id="pf-mfa-code" [(ngModel)]="mfaCode" autocomplete="one-time-code">
          </div>
          <div class="pf-actions pf-actions-tight">
            <button class="btn btn-sm mfa-regenerate" type="button" (click)="regenerateCodes()" [disabled]="mfaBusy || !mfaCode">New recovery codes</button>
            @if (!mfaStatus!.required) {
              <button class="btn btn-sm btn-danger mfa-disable" type="button" (click)="disableMfa()" [disabled]="mfaBusy || !mfaCode">Turn off</button>
            }
          </div>
        } @else if (mfaStatus) {
          <p class="pf-intro">{{ mfaStatus.required ? 'Your role requires it. Set up an authenticator app to continue.' : 'Revealing secrets needs it. Set up an authenticator app to turn it on.' }}</p>
          <app-mfa-enrollment [account]="me.email" (completed)="loadMfa()"></app-mfa-enrollment>
        }
        @if (mfaMessage) {
          <p class="pf-msg" role="status">{{ mfaMessage }}</p>
        }
      </div>
    </section>

    <section class="card card-flush" aria-labelledby="pf-password">
      <div class="card-header"><h2 id="pf-password">Password</h2></div>
      <div class="pf-body">
        @if (me.hasPassword) {
          <div class="form-group">
            <label for="pf-current">Current password</label>
            <input id="pf-current" type="password" [(ngModel)]="currentPassword" autocomplete="current-password">
          </div>
        }
        <div class="form-group">
          <label for="pf-new">New password</label>
          <input id="pf-new" type="password" [(ngModel)]="newPassword" autocomplete="new-password">
          <span class="form-hint">At least 8 characters.</span>
        </div>
        <div class="pf-actions">
          <button type="button" class="btn btn-primary" (click)="changePassword()" [disabled]="savingPassword">{{ me.hasPassword ? 'Change password' : 'Set password' }}</button>
        </div>
      </div>
    </section>
  </div>
</div>
`
})
export class ProfileComponent implements OnInit {
  me: any = { name: '', email: '', username: '', role: '', avatarUrl: '', githubId: null, gitlabId: null, hasPassword: false };
  currentPassword = '';
  newPassword = '';
  saving = false;
  savingPassword = false;
  mfaStatus: MfaStatus | null = null;
  mfaCode = '';
  mfaBusy = false;
  mfaMessage = '';
  newRecoveryCodes: string[] = [];
  error = '';
  success = '';

  private dialog = inject(DialogService);

  constructor(private api: ApiService, private auth: AuthService, private mfa: MfaService) {}

  get initials(): string {
    const n = this.me?.name || this.me?.email || '?';
    const parts = String(n).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(n).slice(0, 2).toUpperCase();
  }

  async ngOnInit() {
    await Promise.all([this.load(), this.loadMfa()]);
  }

  async loadMfa() {
    try {
      this.mfaStatus = await firstValueFrom(this.mfa.status());
    } catch {
      this.mfaStatus = null;
    }
  }

  async regenerateCodes() {
    this.mfaBusy = true;
    this.mfaMessage = '';
    try {
      const res = await firstValueFrom(this.mfa.regenerateRecoveryCodes(this.mfaCode.trim()));
      this.newRecoveryCodes = res.recoveryCodes || [];
      this.mfaMessage = 'New recovery codes generated. The old codes no longer work — save these now.';
      await this.loadMfa();
    } catch (err: any) {
      this.mfaMessage = err?.status === 429 ? 'Too many attempts. Try again later.' : 'That code is not valid.';
    } finally {
      this.mfaCode = '';
      this.mfaBusy = false;
    }
  }

  async disableMfa() {
    const ok = await this.dialog.confirm({
      title: 'Turn off two-factor authentication?',
      message: 'Signing in will only need your password. You can turn it on again at any time.',
      confirmLabel: 'Turn off',
      danger: true,
    });
    if (!ok) return;
    this.mfaBusy = true;
    this.mfaMessage = '';
    try {
      await firstValueFrom(this.mfa.disable(this.mfaCode.trim()));
      this.newRecoveryCodes = [];
      this.mfaMessage = 'Two-factor authentication is off.';
      await this.loadMfa();
    } catch (err: any) {
      this.mfaMessage = err?.error?.error === 'mfa_required_by_policy' ? 'Your role requires two-factor authentication.' : 'That code is not valid.';
    } finally {
      this.mfaCode = '';
      this.mfaBusy = false;
    }
  }

  downloadCodes() {
    downloadRecoveryCodes(this.newRecoveryCodes, this.me.email);
  }

  async load() {
    try {
      this.me = await firstValueFrom(this.api.getMe());
      this.auth.setUser({
        id: this.me.id,
        name: this.me.name,
        email: this.me.email,
        role: this.me.role,
        avatarUrl: this.me.avatarUrl,
      });
    } catch (err: any) {
      this.error = err.error?.error || err.message || 'Failed to load profile';
    }
  }

  async saveProfile() {
    this.error = '';
    this.success = '';
    this.saving = true;
    try {
      this.me = await firstValueFrom(this.api.updateMe({ name: this.me.name, avatarUrl: this.me.avatarUrl }));
      this.auth.setUser({ name: this.me.name, avatarUrl: this.me.avatarUrl });
      this.success = 'Profile saved.';
    } catch (err: any) {
      this.error = err.error?.error || err.message || 'Failed to save profile';
    } finally {
      this.saving = false;
    }
  }

  async changePassword() {
    this.error = '';
    this.success = '';
    if (!this.newPassword || this.newPassword.length < 8) {
      this.error = 'New password must be at least 8 characters.';
      return;
    }
    this.savingPassword = true;
    try {
      await firstValueFrom(this.api.setPassword({
        currentPassword: this.currentPassword || undefined,
        newPassword: this.newPassword,
      }));
      this.currentPassword = '';
      this.newPassword = '';
      this.me.hasPassword = true;
      this.success = 'Password updated.';
    } catch (err: any) {
      this.error = err.error?.error || err.message || 'Failed to update password';
    } finally {
      this.savingPassword = false;
    }
  }
}
