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
  styleUrl: './settings.component.css',
  template: `
<section class="st-section" aria-labelledby="st-connect-title">
  <h2 id="st-connect-title" class="st-advanced">Connect Git providers</h2>
  <p class="st-intro">
    GitHub: one click creates a private GitHub App on your account or organization, with nothing to copy.
    GitLab: paste a token with the <code>api</code> scope once and the platform creates the sign-in application.
    Both need to reach this install's public URL; an sslip.io domain works.
  </p>
  @for (w of status?.warnings || []; track w) {
    <p class="st-msg st-warn-text">{{ w }}</p>
  }
  @if (message) {
    <p class="st-msg" [class.st-ok]="messageOk" [class.st-err]="!messageOk" role="status">{{ message }}</p>
  }
</section>

<div class="st-grid">
  <!-- GitHub -->
  <section class="card card-flush" aria-labelledby="st-gh-app">
    <div class="card-header">
      <h2 id="st-gh-app">GitHub App</h2>
      <span class="status" [class.status-ok]="gh?.connected && gh?.health?.ok !== false" [class.status-down]="gh?.connected && gh?.health?.ok === false">
        {{ !gh?.connected ? 'Not connected' : gh?.health?.ok === false ? 'Unhealthy' : 'Connected' }}
      </span>
    </div>
    <div class="st-body">
      @if (gh?.connected) {
        <dl class="facts st-facts">
          <dt>App</dt><dd><a [href]="gh.htmlUrl" target="_blank" rel="noopener">{{ gh.slug }}</a> <span class="muted">(id {{ gh.appId }})</span></dd>
          <dt>Owner</dt><dd>{{ gh.owner || '—' }} {{ gh.ownerType ? '(' + gh.ownerType + ')' : '' }}</dd>
          <dt>Installations</dt><dd>{{ gh.installations }}</dd>
          <dt>Sign-in</dt><dd>{{ gh.loginEnabled ? 'Live' : 'Off' }} <span class="muted">(credentials from {{ sourceLabel(gh.loginSource) }})</span></dd>
          @if (gh.health?.checkedAt) {
            <dt>Last check</dt><dd>{{ gh.health.checkedAt | date:'short' }}{{ gh.health.error ? ': ' + gh.health.error : '' }}</dd>
          }
        </dl>
        <div class="st-item-actions">
          <a class="btn btn-sm btn-primary" [href]="gh.installUrl" target="_blank" rel="noopener">Install on repositories</a>
          <button type="button" class="btn btn-sm" (click)="check('github')" [disabled]="!isAdmin || busy">Check health</button>
          <button type="button" class="btn btn-sm" (click)="syncInstallations()" [disabled]="!isAdmin || busy">Sync installations</button>
          <button type="button" class="btn btn-sm btn-danger" (click)="disconnect('github')" [disabled]="!isAdmin || busy">Disconnect</button>
        </div>
      } @else {
        <p class="st-intro">Sign in with GitHub, repository access and deploy webhooks without personal tokens.</p>
      }
      <details class="st-details" [open]="!gh?.connected">
        <summary>{{ gh?.connected ? 'Reconnect (create a new App)' : 'Connect GitHub' }}</summary>
        <div class="form-group">
          <label for="st-gc-owner">Owner</label>
          <select id="st-gc-owner" [(ngModel)]="ghForm.ownerType">
            <option value="user">My personal account</option>
            <option value="org">An organization</option>
          </select>
        </div>
        @if (ghForm.ownerType === 'org') {
          <div class="form-group">
            <label for="st-gc-org">Organization login</label>
            <input id="st-gc-org" [(ngModel)]="ghForm.org" placeholder="my-org">
          </div>
        }
        <div class="form-group">
          <label for="st-gc-name">App name (optional)</label>
          <input id="st-gc-name" [(ngModel)]="ghForm.name" maxlength="34" placeholder="Generated if empty">
          <span class="form-hint">Must be unique on GitHub, up to 34 characters.</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" (click)="connectGithub()" [disabled]="!isAdmin || busy">Create GitHub App on GitHub</button>
        @if (!isAdmin) { <p class="st-note">Only admins can connect providers.</p> }
      </details>
    </div>
  </section>

  <!-- GitLab -->
  <section class="card card-flush" aria-labelledby="st-gl-app">
    <div class="card-header">
      <h2 id="st-gl-app">GitLab application</h2>
      <span class="status" [class.status-ok]="gl?.connected && gl?.health?.ok !== false" [class.status-down]="gl?.connected && gl?.health?.ok === false">
        {{ !gl?.connected ? 'Not connected' : gl?.health?.ok === false ? 'Unhealthy' : 'Connected' }}
      </span>
    </div>
    <div class="st-body">
      @if (gl?.connected) {
        <dl class="facts st-facts">
          <dt>GitLab</dt><dd class="mono">{{ gl.baseUrl }}</dd>
          <dt>Application</dt><dd>{{ gl.ownerType === 'group' ? 'Group ' + gl.owner : 'Instance-wide' }}</dd>
          <dt>Webhook token</dt><dd>{{ gl.hasApiToken ? 'Kept (encrypted) for project webhooks' : 'Not kept; webhooks use the linking token' }}</dd>
          <dt>Sign-in</dt><dd>{{ gl.loginEnabled ? 'Live' : 'Off' }} <span class="muted">(credentials from {{ sourceLabel(gl.loginSource) }})</span></dd>
          @if (gl.health?.checkedAt) {
            <dt>Last check</dt><dd>{{ gl.health.checkedAt | date:'short' }}{{ gl.health.error ? ': ' + gl.health.error : '' }}</dd>
          }
        </dl>
        <div class="st-item-actions">
          <button type="button" class="btn btn-sm" (click)="check('gitlab')" [disabled]="!isAdmin || busy">Check health</button>
          <button type="button" class="btn btn-sm btn-danger" (click)="disconnect('gitlab')" [disabled]="!isAdmin || busy">Disconnect</button>
        </div>
      }
      <details class="st-details" [open]="!gl?.connected">
        <summary>{{ gl?.connected ? 'Reconnect' : 'Connect GitLab' }}</summary>
        <div class="form-group">
          <label for="st-gc-glurl">GitLab URL</label>
          <input id="st-gc-glurl" [(ngModel)]="glForm.baseUrl" placeholder="https://gitlab.com">
        </div>
        <div class="form-group">
          <label for="st-gc-gltoken">Token with api scope</label>
          <input id="st-gc-gltoken" type="password" [(ngModel)]="glForm.token" placeholder="glpat-…" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="st-gc-glgroup">Group path (if you are not an instance admin)</label>
          <input id="st-gc-glgroup" [(ngModel)]="glForm.groupPath" placeholder="my-group/sub-group">
        </div>
        <label class="st-check"><input type="checkbox" id="glKeep" [(ngModel)]="glForm.keepToken"> Keep this token (encrypted) to register project webhooks automatically</label>
        <div>
          <button type="button" class="btn btn-primary btn-sm" (click)="connectGitlab()" [disabled]="!isAdmin || busy || !glForm.token">Create GitLab application</button>
        </div>
        <p class="st-note">If you don't keep it, the token is used once and discarded.</p>
      </details>
    </div>
  </section>
</div>

@if (installations.length) {
  <section class="card card-flush st-section" aria-labelledby="st-gc-inst">
    <div class="card-header"><h2 id="st-gc-inst">GitHub App installations</h2></div>
    <ul class="st-list">
      @for (i of installations; track i.installationId) {
        <li>
          <div class="st-item-main">
            <span class="st-item-tags">
              <span class="st-item-name">{{ i.account }}</span>
              <span class="muted">({{ i.accountType }})</span>
              @if (i.suspended) { <span class="status status-down">Suspended</span> }
            </span>
            <span class="secondary">{{ i.repositorySelection === 'all' ? 'All repositories' : (i.repositories.length + ' selected repositories') }}</span>
            @if (i.repositorySelection !== 'all' && i.repositories.length) {
              <span class="st-item-meta mono">{{ i.repositories.join(', ') }}</span>
            }
            <span class="st-item-meta">Projects: {{ i.projects.length ? projectNames(i.projects) : 'none linked yet' }}</span>
          </div>
        </li>
      }
    </ul>
  </section>
}

<h2 class="st-advanced">Manual OAuth app entry</h2>
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
