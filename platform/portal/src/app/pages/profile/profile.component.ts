import { Component, OnInit } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { MfaService, MfaStatus, downloadRecoveryCodes } from '../../services/mfa.service';
import { MfaEnrollmentComponent } from '../../shared/mfa-enrollment.component';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [FormsModule, MfaEnrollmentComponent],
  template: `
<div>
  <div class="card" style="background:linear-gradient(135deg, rgba(91,110,245,0.05), rgba(45,212,160,0.02)); border-color:var(--border-subtle); margin-bottom:20px;">
    <h1 style="margin:0 0 4px 0; font-size:1.3rem; font-family:var(--font-heading);">Profile</h1>
    <p style="margin:0; color:var(--text-secondary); font-size:0.8rem;">Your account, linked GitHub / GitLab identities, and password.</p>
  </div>

  @if (error) {
    <div class="card" style="margin-bottom:16px; color:var(--accent-danger);">{{ error }}</div>
  }
  @if (success) {
    <div class="card" style="margin-bottom:16px; color:var(--accent-success);">{{ success }}</div>
  }

  <div class="grid-2" style="align-items:start;">
    <div class="card" style="padding:20px;">
      <h2>Account</h2>
      <div style="display:flex; gap:14px; align-items:center; margin-bottom:16px;">
        <div style="width:56px; height:56px; border-radius:50%; overflow:hidden; background:#111; display:flex; align-items:center; justify-content:center; border:1px solid var(--border-subtle);">
          @if (me.avatarUrl) {
            <img [src]="me.avatarUrl" alt="" style="width:100%; height:100%; object-fit:cover;">
          }
          @if (!me.avatarUrl) {
            <span style="font-weight:700;">{{ initials }}</span>
          }
        </div>
        <div>
          <div style="font-weight:700; color:#fff;">{{ me.name || '—' }}</div>
          <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-code);">{{ me.email }}</div>
          <div class="badge badge-active" style="font-size:0.6rem; margin-top:6px;">{{ me.role }}</div>
        </div>
      </div>
      <div class="form-group">
        <label>Name</label>
        <input [(ngModel)]="me.name" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Avatar URL</label>
        <input [(ngModel)]="me.avatarUrl" placeholder="https://…" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Email</label>
        <input [value]="me.email" [readonly]="true" style="width:100%; background:rgba(0,0,0,0.15); cursor:not-allowed;">
      </div>
      <div class="form-group">
        <label>Username</label>
        <input [value]="me.username || '—'" [readonly]="true" style="width:100%; background:rgba(0,0,0,0.15); cursor:not-allowed;">
      </div>
      <button class="btn btn-primary" (click)="saveProfile()" [disabled]="saving">Save profile</button>
    </div>

    <div>
      <div class="card" style="padding:20px; margin-bottom:16px;">
        <h2>Linked logins</h2>
        <p style="color:var(--text-secondary); font-size:0.78rem;">GitHub and GitLab login are configured by an admin under Settings → Login. Signing in with either provider links that identity here.</p>
        <div style="display:flex; flex-direction:column; gap:10px; margin-top:12px;">
          <div style="background:rgba(0,0,0,0.15); border:1px solid var(--border-subtle); border-radius:6px; padding:12px;">
            <div style="font-weight:700; font-size:0.82rem;">GitHub</div>
            <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-code);">{{ me.githubId ? ('linked · ' + me.githubId) : 'Not linked' }}</div>
          </div>
          <div style="background:rgba(0,0,0,0.15); border:1px solid var(--border-subtle); border-radius:6px; padding:12px;">
            <div style="font-weight:700; font-size:0.82rem;">GitLab</div>
            <div style="font-size:0.75rem; color:var(--text-muted); font-family:var(--font-code);">{{ me.gitlabId ? ('linked · ' + me.gitlabId) : 'Not linked' }}</div>
          </div>
        </div>
      </div>

      <div class="card mfa-card" style="padding:20px; margin-bottom:16px;">
        <h2>Two-factor authentication</h2>
        @if (mfaStatus?.enabled) {
          <p class="mfa-on" style="font-size:0.82rem; margin:0 0 8px;">
            <span style="color:var(--accent-success);">● On</span>
            · {{ mfaStatus!.recoveryCodesRemaining }} recovery code{{ mfaStatus!.recoveryCodesRemaining === 1 ? '' : 's' }} left
          </p>
          @if (mfaStatus!.required) {
            <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 8px;">Required for your role ({{ me.role }}).</p>
          }
          @if (newRecoveryCodes.length) {
            <ul class="mfa-new-codes" style="columns:2; list-style:none; padding:10px; font-family:var(--font-code); background:rgba(0,0,0,0.2); border-radius:6px;">
              @for (c of newRecoveryCodes; track c) { <li>{{ c }}</li> }
            </ul>
            <button class="btn btn-sm" type="button" (click)="downloadCodes()">Download codes</button>
          }
          <div class="form-group" style="margin-top:10px;">
            <label>Current code (authenticator or recovery code)</label>
            <input [(ngModel)]="mfaCode" autocomplete="one-time-code" style="width:100%;">
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-sm mfa-regenerate" type="button" (click)="regenerateCodes()" [disabled]="mfaBusy || !mfaCode">New recovery codes</button>
            @if (!mfaStatus!.required) {
              <button class="btn btn-sm btn-danger mfa-disable" type="button" (click)="disableMfa()" [disabled]="mfaBusy || !mfaCode">Turn off</button>
            }
          </div>
        } @else if (mfaStatus) {
          <p style="font-size:0.82rem; color:var(--text-secondary); margin:0 0 10px;">
            Off. {{ mfaStatus.required ? 'Your role requires it.' : 'Revealing secrets needs it.' }}
          </p>
          <app-mfa-enrollment [account]="me.email" (completed)="loadMfa()"></app-mfa-enrollment>
        }
        @if (mfaMessage) {
          <div style="font-size:0.8rem; margin-top:8px;">{{ mfaMessage }}</div>
        }
      </div>

      <div class="card" style="padding:20px;">
        <h2>Password</h2>
        @if (me.hasPassword) {
          <div class="form-group">
            <label>Current password</label>
            <input type="password" [(ngModel)]="currentPassword" style="width:100%;" autocomplete="current-password">
          </div>
        }
        <div class="form-group">
          <label>New password</label>
          <input type="password" [(ngModel)]="newPassword" style="width:100%;" autocomplete="new-password">
        </div>
        <button class="btn btn-primary" (click)="changePassword()" [disabled]="savingPassword">{{ me.hasPassword ? 'Change password' : 'Set password' }}</button>
      </div>
    </div>
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
    if (!confirm('Turn off two-factor authentication?')) return;
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
