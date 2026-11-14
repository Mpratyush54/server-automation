import { Component, Input, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { StepUpService } from '../../services/step-up.service';
import { DialogService } from '../../shared/feedback/feedback.service';

/**
 * One-click Git provider connect (#35): GitHub App via the App Manifest flow, GitLab OAuth
 * application from a pasted api-scoped token. Shows status/health per provider with
 * reconnect / check / disconnect. Manual OAuth app entry is the Advanced disclosure on the Settings sign-in tab.
 */
@Component({
  selector: 'app-git-connect',
  standalone: true,
  imports: [CommonModule, FormsModule],
  styleUrl: './settings.component.css',
  template: `
<section class="st-section st-connect-head" aria-labelledby="st-connect-title">
  <h2 id="st-connect-title" class="st-advanced">Connect your Git provider</h2>
  <p class="st-intro">
    Connect once and people can sign in with GitHub or GitLab, and Cairn can read repositories and deploy on push.
    <a class="st-learn" href="https://platform.pratyushes.dev/docs/guides/git-providers" target="_blank" rel="noopener">Learn more</a>
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
      <h2 id="st-gh-app">GitHub</h2>
      <span class="status" [class.status-ok]="gh?.connected && gh?.health?.ok !== false" [class.status-down]="gh?.connected && gh?.health?.ok === false">
        {{ !gh?.connected ? 'Not connected' : gh?.health?.ok === false ? 'Not working' : 'Connected' }}
      </span>
    </div>
    <div class="st-body">
      @if (gh?.connected) {
        <dl class="facts st-facts">
          <dt>App</dt><dd><a [href]="gh.htmlUrl" target="_blank" rel="noopener">{{ gh.slug }}</a> <span class="muted">(id {{ gh.appId }})</span></dd>
          <dt>Owner</dt><dd>{{ gh.owner || '—' }} {{ gh.ownerType ? '(' + gh.ownerType + ')' : '' }}</dd>
          <dt>Installed on</dt><dd>{{ gh.installations }} {{ gh.installations === 1 ? 'account' : 'accounts' }}</dd>
          <dt>Sign-in</dt><dd>{{ gh.loginEnabled ? 'On' : 'Off' }} <span class="muted">(from {{ sourceLabel(gh.loginSource) }})</span></dd>
          @if (gh.health?.checkedAt) {
            <dt>Last check</dt><dd>{{ gh.health.checkedAt | date:'short' }}{{ gh.health.error ? ': ' + gh.health.error : '' }}</dd>
          }
        </dl>
        <div class="st-item-actions">
          <a class="btn btn-sm btn-primary" [href]="gh.installUrl" target="_blank" rel="noopener">Choose repositories</a>
          <button type="button" class="btn btn-sm" (click)="check('github')" [disabled]="!isAdmin || busy">Check connection</button>
          <button type="button" class="btn btn-sm btn-ghost" (click)="syncInstallations()" [disabled]="!isAdmin || busy">Refresh repositories</button>
          <button type="button" class="btn btn-sm btn-ghost st-danger-text" (click)="disconnect('github')" [disabled]="!isAdmin || busy">Disconnect</button>
        </div>
      } @else {
        <p class="st-intro">Creates a private GitHub App on your account or organization. Nothing to copy or paste.</p>
      }
      <details class="st-details" [open]="!gh?.connected">
        <summary>{{ gh?.connected ? 'Reconnect with a new app' : 'Connect GitHub' }}</summary>
        <div class="form-group">
          <label for="st-gc-owner">Create it under</label>
          <select id="st-gc-owner" [(ngModel)]="ghForm.ownerType">
            <option value="user">My personal account</option>
            <option value="org">An organization</option>
          </select>
        </div>
        @if (ghForm.ownerType === 'org') {
          <div class="form-group">
            <label for="st-gc-org">Organization name</label>
            <input id="st-gc-org" [(ngModel)]="ghForm.org" placeholder="my-org">
          </div>
        }
        <div class="form-group">
          <label for="st-gc-name">App name (optional)</label>
          <input id="st-gc-name" [(ngModel)]="ghForm.name" maxlength="34" placeholder="Generated if empty">
          <span class="form-hint">Must be unique on GitHub, up to 34 characters.</span>
        </div>
        <button type="button" class="btn btn-primary btn-sm" (click)="connectGithub()" [disabled]="!isAdmin || busy">Continue on GitHub</button>
        @if (!isAdmin) { <p class="st-note">Only admins can connect providers.</p> }
      </details>
    </div>
  </section>

  <!-- GitLab -->
  <section class="card card-flush" aria-labelledby="st-gl-app">
    <div class="card-header">
      <h2 id="st-gl-app">GitLab</h2>
      <span class="status" [class.status-ok]="gl?.connected && gl?.health?.ok !== false" [class.status-down]="gl?.connected && gl?.health?.ok === false">
        {{ !gl?.connected ? 'Not connected' : gl?.health?.ok === false ? 'Not working' : 'Connected' }}
      </span>
    </div>
    <div class="st-body">
      @if (gl?.connected) {
        <dl class="facts st-facts">
          <dt>Address</dt><dd class="mono">{{ gl.baseUrl }}</dd>
          <dt>Scope</dt><dd>{{ gl.ownerType === 'group' ? 'Group ' + gl.owner : 'Whole server' }}</dd>
          <dt>Push events</dt><dd>{{ gl.hasApiToken ? 'Set up automatically' : 'Use the GitLab token on Git linking' }}</dd>
          <dt>Sign-in</dt><dd>{{ gl.loginEnabled ? 'On' : 'Off' }} <span class="muted">(from {{ sourceLabel(gl.loginSource) }})</span></dd>
          @if (gl.health?.checkedAt) {
            <dt>Last check</dt><dd>{{ gl.health.checkedAt | date:'short' }}{{ gl.health.error ? ': ' + gl.health.error : '' }}</dd>
          }
        </dl>
        <div class="st-item-actions">
          <button type="button" class="btn btn-sm" (click)="check('gitlab')" [disabled]="!isAdmin || busy">Check connection</button>
          <button type="button" class="btn btn-sm btn-ghost st-danger-text" (click)="disconnect('gitlab')" [disabled]="!isAdmin || busy">Disconnect</button>
        </div>
      } @else {
        <p class="st-intro">Paste a GitLab token once and Cairn creates the sign-in application for you.</p>
      }
      <details class="st-details" [open]="!gl?.connected">
        <summary>{{ gl?.connected ? 'Reconnect' : 'Connect GitLab' }}</summary>
        <div class="form-group">
          <label for="st-gc-glurl">GitLab address</label>
          <input id="st-gc-glurl" [(ngModel)]="glForm.baseUrl" placeholder="https://gitlab.com">
        </div>
        <div class="form-group">
          <label for="st-gc-gltoken">Access token</label>
          <input id="st-gc-gltoken" type="password" [(ngModel)]="glForm.token" placeholder="glpat-…" autocomplete="off">
          <span class="form-hint">Create it in GitLab with the <span class="mono">api</span> scope. Used once unless you keep it below.</span>
        </div>
        <div class="form-group">
          <label for="st-gc-glgroup">Group (optional)</label>
          <input id="st-gc-glgroup" [(ngModel)]="glForm.groupPath" placeholder="my-group/sub-group">
          <span class="form-hint">Needed if you are not an admin of the GitLab server.</span>
        </div>
        <label class="st-check"><input type="checkbox" id="glKeep" [(ngModel)]="glForm.keepToken"> Keep the token (encrypted) to set up push events for new projects</label>
        <div>
          <button type="button" class="btn btn-primary btn-sm" (click)="connectGitlab()" [disabled]="!isAdmin || busy || !glForm.token">Connect GitLab</button>
        </div>
        @if (!isAdmin) { <p class="st-note">Only admins can connect providers.</p> }
      </details>
    </div>
  </section>
</div>

@if (installations.length) {
  <section class="card card-flush st-section" aria-labelledby="st-gc-inst">
    <div class="card-header"><h2 id="st-gc-inst">Where the GitHub App is installed</h2></div>
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
`,
})
export class GitConnectComponent implements OnInit {
  private dialog = inject(DialogService);

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
    return ({ app: 'the connected app', manual: 'manual entry', env: 'environment', none: 'nowhere (not set up)' } as any)[s] || s;
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
      this.say('GitHub connected. Now choose the repositories Cairn may deploy.');
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
      this.say(`GitLab connected${res.mode === 'group' ? ' for the group' : ''}. "Sign in with GitLab" is on.`);
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
      this.say(res.ok ? `${provider === 'github' ? 'GitHub' : 'GitLab'} connection works.` : `Check failed: ${res.error}`, !!res.ok);
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
      this.say(`Repository access refreshed (${this.installations.length} ${this.installations.length === 1 ? 'account' : 'accounts'}).`);
      await this.load();
    } catch (err) {
      this.say(this.errText(err), false);
    } finally {
      this.busy = false;
    }
  }

  async disconnect(provider: 'github' | 'gitlab') {
    const name = provider === 'github' ? 'GitHub App' : 'GitLab application';
    const ok = await this.dialog.confirm({
      title: `Disconnect the ${name}?`,
      message: `The stored ${name} credentials are removed. Sign-in and repository access through it stop working until you connect it again.`,
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
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
