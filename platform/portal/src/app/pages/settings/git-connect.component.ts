import { Component, Input, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { StepUpService } from '../../services/step-up.service';

/**
 * One-click Git provider connect (#35): GitHub App via the App Manifest flow, GitLab OAuth
 * application from a pasted api-scoped token. Shows status/health per provider with
 * reconnect / check / disconnect. Manual OAuth app entry stays below as the advanced fallback.
 */
@Component({
  selector: 'app-git-connect',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
<div class="card" style="margin-bottom:16px; padding:16px;">
  <h2 style="margin-top:0;">Connect Git providers</h2>
  <p style="margin:0; color:var(--text-secondary); font-size:0.8rem;">
    GitHub: one click creates a private GitHub App on your account or organization (nothing to copy).
    GitLab: paste a token with the <code>api</code> scope once and the platform creates the login application.
    GitHub and GitLab must reach this install's public URL; an sslip.io domain works.
  </p>
  @for (w of status?.warnings || []; track w) {
    <div style="margin-top:8px; font-size:0.78rem; color:var(--accent-warning);">⚠ {{ w }}</div>
  }
  @if (message) {
    <div style="margin-top:10px; font-size:0.8rem;" [style.color]="messageOk ? 'var(--accent-success)' : 'var(--accent-danger)'">{{ message }}</div>
  }
</div>

<div class="grid-2" style="align-items:start; margin-bottom:16px;">
  <!-- GitHub -->
  <div class="card" style="padding:20px;">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <h2 style="margin:0;">GitHub App</h2>
      <span class="badge" [class.badge-active]="gh?.connected && gh?.health?.ok !== false" [class.badge-failed]="gh?.connected && gh?.health?.ok === false" [class.badge-pending]="!gh?.connected">
        {{ !gh?.connected ? 'Not connected' : gh?.health?.ok === false ? 'Unhealthy' : 'Connected' }}
      </span>
    </div>
    @if (gh?.connected) {
      <div style="font-size:0.8rem; margin-top:10px; line-height:1.7;">
        <div>App: <a [href]="gh.htmlUrl" target="_blank" rel="noopener">{{ gh.slug }}</a> (id {{ gh.appId }})</div>
        <div>Owner: {{ gh.owner || '—' }} {{ gh.ownerType ? '(' + gh.ownerType + ')' : '' }}</div>
        <div>Installations: {{ gh.installations }}</div>
        <div>Login: {{ gh.loginEnabled ? 'live' : 'off' }} (credentials from {{ sourceLabel(gh.loginSource) }})</div>
        @if (gh.health?.checkedAt) {
          <div style="color:var(--text-muted);">Last check {{ gh.health.checkedAt | date:'short' }}{{ gh.health.error ? ': ' + gh.health.error : '' }}</div>
        }
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:12px;">
        <a class="btn btn-sm btn-primary" [href]="gh.installUrl" target="_blank" rel="noopener">Install on repositories</a>
        <button class="btn btn-sm" (click)="check('github')" [disabled]="!isAdmin || busy">Check health</button>
        <button class="btn btn-sm" (click)="syncInstallations()" [disabled]="!isAdmin || busy">Sync installations</button>
        <button class="btn btn-sm" (click)="disconnect('github')" [disabled]="!isAdmin || busy">Disconnect</button>
      </div>
    } @else {
      <p style="font-size:0.78rem; color:var(--text-secondary);">Login with GitHub, repository access and deploy webhooks without personal tokens.</p>
    }
    <details style="margin-top:12px;" [open]="!gh?.connected">
      <summary style="cursor:pointer; font-size:0.8rem;">{{ gh?.connected ? 'Reconnect (create a new App)' : 'Connect GitHub' }}</summary>
      <div class="form-group" style="margin-top:10px;">
        <label>Owner</label>
        <select [(ngModel)]="ghForm.ownerType" style="width:100%;">
          <option value="user">My personal account</option>
          <option value="org">An organization</option>
        </select>
      </div>
      @if (ghForm.ownerType === 'org') {
        <div class="form-group">
          <label>Organization login</label>
          <input [(ngModel)]="ghForm.org" placeholder="my-org" style="width:100%;">
        </div>
      }
      <div class="form-group">
        <label>App name (optional, unique on GitHub, max 34)</label>
        <input [(ngModel)]="ghForm.name" maxlength="34" placeholder="Generated if empty" style="width:100%;">
      </div>
      <button class="btn btn-primary btn-sm" (click)="connectGithub()" [disabled]="!isAdmin || busy">Create GitHub App on GitHub</button>
      @if (!isAdmin) { <div style="font-size:0.72rem; color:var(--text-muted); margin-top:6px;">Only admins can connect providers.</div> }
    </details>
  </div>

  <!-- GitLab -->
  <div class="card" style="padding:20px;">
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
      <h2 style="margin:0;">GitLab application</h2>
      <span class="badge" [class.badge-active]="gl?.connected && gl?.health?.ok !== false" [class.badge-failed]="gl?.connected && gl?.health?.ok === false" [class.badge-pending]="!gl?.connected">
        {{ !gl?.connected ? 'Not connected' : gl?.health?.ok === false ? 'Unhealthy' : 'Connected' }}
      </span>
    </div>
    @if (gl?.connected) {
      <div style="font-size:0.8rem; margin-top:10px; line-height:1.7;">
        <div>GitLab: {{ gl.baseUrl }}</div>
        <div>Application: {{ gl.ownerType === 'group' ? 'group ' + gl.owner : 'instance-wide' }}</div>
        <div>Webhook token: {{ gl.hasApiToken ? 'kept (encrypted) for project webhooks' : 'not kept — webhooks use the linking token' }}</div>
        <div>Login: {{ gl.loginEnabled ? 'live' : 'off' }} (credentials from {{ sourceLabel(gl.loginSource) }})</div>
        @if (gl.health?.checkedAt) {
          <div style="color:var(--text-muted);">Last check {{ gl.health.checkedAt | date:'short' }}{{ gl.health.error ? ': ' + gl.health.error : '' }}</div>
        }
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:12px;">
        <button class="btn btn-sm" (click)="check('gitlab')" [disabled]="!isAdmin || busy">Check health</button>
        <button class="btn btn-sm" (click)="disconnect('gitlab')" [disabled]="!isAdmin || busy">Disconnect</button>
      </div>
    }
    <details style="margin-top:12px;" [open]="!gl?.connected">
      <summary style="cursor:pointer; font-size:0.8rem;">{{ gl?.connected ? 'Reconnect' : 'Connect GitLab' }}</summary>
      <div class="form-group" style="margin-top:10px;">
        <label>GitLab URL</label>
        <input [(ngModel)]="glForm.baseUrl" placeholder="https://gitlab.com" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Token with api scope</label>
        <input type="password" [(ngModel)]="glForm.token" placeholder="glpat-…" autocomplete="off" style="width:100%;">
      </div>
      <div class="form-group">
        <label>Group path (if you are not an instance admin)</label>
        <input [(ngModel)]="glForm.groupPath" placeholder="my-group/sub-group" style="width:100%;">
      </div>
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
        <input type="checkbox" id="glKeep" [(ngModel)]="glForm.keepToken" style="width:14px; height:14px;">
        <label for="glKeep" style="margin:0; cursor:pointer; text-transform:none; letter-spacing:0; font-size:0.78rem;">Keep this token (encrypted) to register project webhooks automatically</label>
      </div>
      <button class="btn btn-primary btn-sm" (click)="connectGitlab()" [disabled]="!isAdmin || busy || !glForm.token">Create GitLab application</button>
      <div style="font-size:0.72rem; color:var(--text-muted); margin-top:6px;">Without "keep", the token is used once and discarded.</div>
    </details>
  </div>
</div>

@if (installations.length) {
  <div class="card" style="padding:16px; margin-bottom:16px;">
    <h2 style="margin-top:0;">GitHub App installations</h2>
    @for (i of installations; track i.installationId) {
      <div style="font-size:0.8rem; padding:8px 0; border-top:1px solid var(--border-subtle);">
        <strong>{{ i.account }}</strong> ({{ i.accountType }}) — {{ i.repositorySelection === 'all' ? 'all repositories' : (i.repositories.length + ' selected repositories') }}
        @if (i.suspended) { <span class="badge badge-failed">suspended</span> }
        @if (i.repositorySelection !== 'all' && i.repositories.length) {
          <div style="color:var(--text-secondary);">{{ i.repositories.join(', ') }}</div>
        }
        <div style="color:var(--text-muted);">Projects: {{ i.projects.length ? projectNames(i.projects) : 'none linked yet' }}</div>
      </div>
    }
  </div>
}

<h3 style="font-size:0.9rem; margin:8px 0;">Advanced: manual OAuth app entry</h3>
`,
})
export class GitConnectComponent implements OnInit {
  @Input() isAdmin = false;

  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private stepUp = inject(StepUpService);

  status: any = null;
  installations: any[] = [];
  busy = false;
  message = '';
  messageOk = true;
  ghForm = { ownerType: 'user', org: '', name: '' };
  glForm = { baseUrl: 'https://gitlab.com', token: '', groupPath: '', keepToken: false };

  get gh(): any { return this.status?.github; }
  get gl(): any { return this.status?.gitlab; }

  async ngOnInit() {
    await this.load();
    const q = this.route.snapshot.queryParamMap;
    const code = q.get('code');
    const state = q.get('state');
    if (code && state) {
      await this.completeGithub(code, state);
    } else if (q.get('installation_id') && this.isAdmin) {
      await this.clearQuery();
      await this.syncInstallations();
    }
  }

  sourceLabel(s: string): string {
    return ({ app: 'the connected app', manual: 'manual entry', env: 'environment', none: 'nowhere — not configured' } as any)[s] || s;
  }

  projectNames(list: any[]): string {
    return list.map((p) => p.name).join(', ');
  }

  private say(msg: string, ok = true) {
    this.message = msg;
    this.messageOk = ok;
  }

  private errText(err: any): string {
    return err?.error?.error || err?.message || 'Request failed';
  }

  private async clearQuery() {
    await this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
  }

  async load() {
    try {
      this.status = await firstValueFrom(this.http.get<any>('/api/settings/integrations/git'));
      if (this.gl?.baseUrl) this.glForm.baseUrl = this.gl.baseUrl;
      const inst = await firstValueFrom(this.http.get<any>('/api/settings/integrations/github/installations'));
      this.installations = inst?.installations || [];
    } catch (err) {
      this.say(this.errText(err), false);
    }
  }

  async connectGithub() {
    this.busy = true;
    this.say('');
    try {
      const body = { ownerType: this.ghForm.ownerType, org: this.ghForm.org.trim(), name: this.ghForm.name.trim() || undefined };
      const res: any = await this.stepUp.run(
        () => firstValueFrom(this.http.post<any>('/api/settings/integrations/github/manifest', body)),
        'Connect GitHub',
      );
      // GitHub only accepts a manifest as a form POST from the browser.
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = res.postUrl;
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'manifest';
      input.value = JSON.stringify(res.manifest);
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      this.say(this.errText(err), false);
      this.busy = false;
    }
  }

  async completeGithub(code: string, state: string) {
    this.busy = true;
    this.say('Finishing GitHub App creation…');
    try {
      const res: any = await this.stepUp.run(
        () => firstValueFrom(this.http.post<any>('/api/settings/integrations/github/manifest/complete', { code, state })),
        'Save the new GitHub App',
      );
      this.say('GitHub App created. Install it on the repositories the platform should deploy.');
      await this.load();
      if (res?.installUrl) window.open(res.installUrl, '_blank', 'noopener');
    } catch (err) {
      this.say(this.errText(err), false);
    } finally {
      await this.clearQuery();
      this.busy = false;
    }
  }

  async connectGitlab() {
    this.busy = true;
    this.say('');
    try {
      const body = { ...this.glForm, groupPath: this.glForm.groupPath.trim() || undefined };
      const res: any = await this.stepUp.run(
        () => firstValueFrom(this.http.post<any>('/api/settings/integrations/gitlab/connect', body)),
        'Connect GitLab',
      );
      this.glForm.token = '';
      this.say(`GitLab ${res.mode === 'group' ? 'group' : 'instance'} application created. "Sign in with GitLab" is live.`);
      await this.load();
    } catch (err: any) {
      const e = err?.error || {};
      if (e.manualRequired) {
        this.say(`${e.error} Redirect URI: ${e.redirectUri} (scopes: ${e.scopes}).`, false);
      } else {
        this.say(this.errText(err), false);
      }
    } finally {
      this.busy = false;
    }
  }

  async check(provider: 'github' | 'gitlab') {
    this.busy = true;
    try {
      const res: any = await firstValueFrom(this.http.post<any>(`/api/settings/integrations/${provider}/check`, {}));
      this.say(res.ok ? `${provider === 'github' ? 'GitHub App' : 'GitLab'} is healthy.` : `Check failed: ${res.error}`, !!res.ok);
      await this.load();
    } catch (err) {
      this.say(this.errText(err), false);
    } finally {
      this.busy = false;
    }
  }

  async syncInstallations() {
    this.busy = true;
    try {
      const res: any = await firstValueFrom(this.http.post<any>('/api/settings/integrations/github/installations/sync', {}));
      this.installations = res?.installations || [];
      this.say(`Installations synced (${this.installations.length}).`);
      await this.load();
    } catch (err) {
      this.say(this.errText(err), false);
    } finally {
      this.busy = false;
    }
  }

  async disconnect(provider: 'github' | 'gitlab') {
    if (!confirm(`Remove the stored ${provider === 'github' ? 'GitHub App' : 'GitLab application'} credentials? Login and repository access through it stop working.`)) return;
    this.busy = true;
    try {
      const res: any = await this.stepUp.run(
        () => firstValueFrom(this.http.delete<any>(`/api/settings/integrations/${provider}/app`)),
        'Disconnect provider',
      );
      this.say(res?.note || 'Disconnected.');
      await this.load();
    } catch (err) {
      this.say(this.errText(err), false);
    } finally {
      this.busy = false;
    }
  }
}
