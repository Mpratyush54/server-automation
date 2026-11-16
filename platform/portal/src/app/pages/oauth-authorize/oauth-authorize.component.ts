import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { StepUpService } from '../../services/step-up.service';
import { isStepUpRequired } from '../../services/mfa.service';

/** OAuth/OIDC parameters forwarded from GET /api/oauth/authorize to the consent screen. */
const FORWARDED_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'resource'];

/** One permission row on the AI assistant consent screen (from GET /api/oauth/consent). */
export interface ConsentScope {
  id: string;
  label: string;
  description: string;
  readOnly: boolean;
  /** The signed-in person's role may grant it. */
  allowed: boolean;
  /** The assistant asked for it. */
  requested: boolean;
  checked: boolean;
}

/**
 * Consent screen for the built-in OAuth/OIDC provider.
 *
 * Two kinds of client reach it:
 *  - single sign-on apps installed with the platform (Grafana, Argo CD, ...): Allow / Cancel;
 *  - AI assistants that registered themselves to use the remote MCP endpoint (#193): the screen
 *    shows the assistant's registered name, where it sends you back, and the permissions it gets,
 *    limited to what your role allows. Approving a new assistant asks for a fresh two-factor code
 *    when your account has two-factor sign-in.
 *
 * The API has already checked client_id + exact redirect_uri before sending the browser here; we
 * re-check and only mint a code after the user clicks "Allow". The code is requested with
 * POST /api/oauth/authorize carrying the session in the Authorization header (added by the auth
 * interceptor), so the session JWT never appears in a URL.
 */
@Component({
  selector: 'app-oauth-authorize',
  standalone: true,
  imports: [],
  styleUrl: './oauth-authorize.component.css',
  template: `
    <main class="oa-page">
      <div class="oa-panel">
        <section class="oa-card" aria-labelledby="oa-title">
          <h1 id="oa-title" class="oa-title">{{ kind === 'mcp' ? 'Connect an AI assistant' : 'Single sign-on' }}</h1>

          @switch (status) {
            @case ('loading') {
              <p class="oa-sub">Checking the application…</p>
              <div class="oa-spinner" role="status" aria-label="Loading"></div>
            }
            @case ('consent') {
              @if (kind === 'mcp') {
                <p class="oa-sub">
                  <strong data-testid="client-name">{{ clientName }}</strong> wants to work with Cairn as you.
                </p>
                <p class="oa-note">This is the name the assistant gave itself. Only continue if you started this connection.</p>
                <p class="oa-note">After you approve, you go back to:</p>
                <p data-testid="redirect-host" class="oa-host mono">{{ redirectHost }}</p>

                <fieldset class="oa-scopes" data-testid="consent-scopes">
                  <legend>It may</legend>
                  @for (s of scopes; track s.id) {
                    <label class="oa-scope" [class.oa-scope-off]="!s.allowed">
                      <input type="checkbox" [checked]="s.checked" [disabled]="!s.allowed || busy"
                        (change)="toggle(s, $any($event.target).checked)" [attr.data-testid]="'scope-' + s.id">
                      <span class="oa-scope-text">
                        <span class="oa-scope-label">
                          {{ s.label }}
                          @if (!s.readOnly) { <span class="badge oa-badge-write">Changes things</span> }
                        </span>
                        <span class="oa-scope-desc">{{ s.allowed ? s.description : 'Your role cannot grant this.' }}</span>
                      </span>
                    </label>
                  }
                </fieldset>
                <p class="oa-note">It never gets more than your own access, and destructive commands still wait for a person to approve them. You can disconnect it any time under AI agents.</p>
                @if (formError) { <p class="oa-error" role="alert">{{ formError }}</p> }
                <div class="oa-actions">
                  <button type="button" class="btn" (click)="deny()" [disabled]="busy">Cancel</button>
                  <button type="button" class="btn btn-primary" (click)="allow()" [disabled]="busy || !selectedScopes.length" data-testid="consent-allow">
                    {{ busy ? 'Approving…' : 'Approve' }}
                  </button>
                </div>
              } @else {
                <p class="oa-sub">
                  <strong>{{ clientName }}</strong> wants to sign you in with your Platform account.
                </p>
                <p class="oa-note">It will receive your name, email and role. You will be sent back to:</p>
                <p data-testid="redirect-host" class="oa-host mono">{{ redirectHost }}</p>
                <div class="oa-actions">
                  <button type="button" class="btn" (click)="deny()" [disabled]="busy">Cancel</button>
                  <button type="button" class="btn btn-primary" (click)="allow()" [disabled]="busy">Allow</button>
                </div>
              }
            }
            @case ('error') {
              <p data-testid="oauth-error" class="oa-error" role="alert">{{ errorMessage }}</p>
              <div class="oa-actions">
                <button type="button" class="btn" (click)="goHome()">Back to Platform</button>
              </div>
            }
          }
        </section>
      </div>
    </main>
    `,
})
export class OauthAuthorizeComponent implements OnInit {
  status: 'loading' | 'consent' | 'error' = 'loading';
  /** `sso`: platform single sign-on app. `mcp`: an AI assistant (remote MCP client). */
  kind: 'sso' | 'mcp' = 'sso';
  clientName = '';
  redirectHost = '';
  errorMessage = '';
  formError = '';
  busy = false;
  scopes: ConsentScope[] = [];

  private params: Record<string, string> = {};
  private stepUp = inject(StepUpService);

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient,
    private auth: AuthService,
  ) {}

  get selectedScopes(): string[] {
    return this.scopes.filter((s) => s.allowed && s.checked).map((s) => s.id);
  }

  async ngOnInit() {
    const query = this.route.snapshot.queryParams || {};
    for (const key of FORWARDED_PARAMS) {
      if (typeof query[key] === 'string' && query[key]) this.params[key] = query[key];
    }

    // The API sends rejected assistant requests here instead of back to the assistant.
    if (typeof query['error'] === 'string' && query['error'] && !this.params['client_id']) {
      this.kind = 'mcp';
      const detail = typeof query['error_description'] === 'string' ? query['error_description'].slice(0, 200) : '';
      return this.fail(`This connection request was refused${detail ? `: ${detail}` : '.'} Start again from your assistant.`);
    }

    if (!this.auth.isAuthenticated()) {
      const returnUrl = this.router.serializeUrl(
        this.router.createUrlTree(['/oauth/authorize'], { queryParams: this.params })
      );
      this.router.navigate(['/login'], { queryParams: { returnUrl } });
      return;
    }

    const clientId = this.params['client_id'];
    const redirectUri = this.params['redirect_uri'];
    if (!clientId || !redirectUri) {
      return this.fail('This sign-in request is missing client_id or redirect_uri.');
    }

    let info: any;
    try {
      info = await firstValueFrom(
        this.http.get<any>(`/api/oauth/clients/${encodeURIComponent(clientId)}`, { params: { redirect_uri: redirectUri } })
      );
    } catch {
      return this.fail('Unknown application. Ask your administrator to register it.');
    }
    if (!info?.redirect_uri_valid) {
      return this.fail('This application is not allowed to use that redirect address.');
    }
    this.clientName = info.name || clientId;
    this.redirectHost = new URL(redirectUri).origin;

    if (info.kind === 'mcp') {
      this.kind = 'mcp';
      try {
        const consent = await firstValueFrom(this.http.get<any>('/api/oauth/consent', { params: this.params }));
        this.clientName = consent?.name || this.clientName;
        this.redirectHost = consent?.redirect_host || this.redirectHost;
        this.scopes = Array.isArray(consent?.scopes) ? consent.scopes : [];
      } catch (err: any) {
        return this.fail(err?.error?.error_description || 'This connection request is not valid. Start again from your assistant.');
      }
    }
    this.status = 'consent';
  }

  toggle(scope: ConsentScope, checked: boolean) {
    if (!scope.allowed) return;
    scope.checked = checked;
    this.formError = '';
  }

  async allow() {
    if (this.busy) return;
    if (this.kind === 'mcp' && !this.selectedScopes.length) {
      this.formError = 'Pick at least one permission.';
      return;
    }
    this.busy = true;
    this.formError = '';
    const body: Record<string, unknown> = { ...this.params };
    if (this.kind === 'mcp') body['scopes'] = this.selectedScopes;
    try {
      const post = () => firstValueFrom(this.http.post<{ redirect: string }>('/api/oauth/authorize', body));
      // A new assistant needs a fresh second factor when the account has one (API: step_up_required).
      const res = this.kind === 'mcp' ? await this.stepUp.run(post, `Approve ${this.clientName}`) : await post();
      if (!res?.redirect) throw new Error('no redirect');
      this.navigateExternal(res.redirect);
    } catch (err: any) {
      this.busy = false;
      if (this.kind === 'mcp' && isStepUpRequired(err)) {
        this.formError = 'Approving a new assistant needs a code from your authenticator app.';
        return;
      }
      if (this.kind === 'mcp' && err?.error?.error === 'invalid_scope') {
        this.formError = err.error.error_description || 'One of the permissions cannot be granted.';
        return;
      }
      this.fail(err?.error?.error_description || 'Could not complete sign-in. Please try again.');
    }
  }

  /** Report access_denied to the (already verified) registered redirect_uri, per RFC 6749 4.1.2.1. */
  deny() {
    const target = new URL(this.params['redirect_uri']);
    target.searchParams.set('error', 'access_denied');
    if (this.params['state']) target.searchParams.set('state', this.params['state']);
    this.navigateExternal(target.toString());
  }

  goHome() {
    this.router.navigate(['/dashboard']);
  }

  /** Separate method so tests can stub the full-page navigation. */
  navigateExternal(url: string) {
    window.location.href = url;
  }

  private fail(message: string) {
    this.errorMessage = message;
    this.status = 'error';
  }
}
