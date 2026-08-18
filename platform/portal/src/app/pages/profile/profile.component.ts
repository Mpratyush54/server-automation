import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
<div>
  <div class="card" style="background:linear-gradient(135deg, rgba(91,110,245,0.05), rgba(45,212,160,0.02)); border-color:var(--border-subtle); margin-bottom:20px;">
    <h1 style="margin:0 0 4px 0; font-size:1.3rem; font-family:var(--font-heading);">Profile</h1>
    <p style="margin:0; color:var(--text-secondary); font-size:0.8rem;">Your account, linked GitHub / GitLab identities, and password.</p>
  </div>

  <div *ngIf="error" class="card" style="margin-bottom:16px; color:var(--accent-danger);">{{ error }}</div>
  <div *ngIf="success" class="card" style="margin-bottom:16px; color:var(--accent-success);">{{ success }}</div>

  <div class="grid-2" style="align-items:start;">
    <div class="card" style="padding:20px;">
      <h2>Account</h2>
      <div style="display:flex; gap:14px; align-items:center; margin-bottom:16px;">
        <div style="width:56px; height:56px; border-radius:50%; overflow:hidden; background:#111; display:flex; align-items:center; justify-content:center; border:1px solid var(--border-subtle);">
          <img *ngIf="me.avatarUrl" [src]="me.avatarUrl" alt="" style="width:100%; height:100%; object-fit:cover;">
          <span *ngIf="!me.avatarUrl" style="font-weight:700;">{{ initials }}</span>
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

      <div class="card" style="padding:20px;">
        <h2>Password</h2>
        <div class="form-group" *ngIf="me.hasPassword">
          <label>Current password</label>
          <input type="password" [(ngModel)]="currentPassword" style="width:100%;" autocomplete="current-password">
        </div>
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
  error = '';
  success = '';

  constructor(private api: ApiService, private auth: AuthService) {}

  get initials(): string {
    const n = this.me?.name || this.me?.email || '?';
    const parts = String(n).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(n).slice(0, 2).toUpperCase();
  }

  async ngOnInit() {
    await this.load();
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
