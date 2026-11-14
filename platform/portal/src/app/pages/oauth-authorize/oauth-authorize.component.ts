import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';

/** OAuth/OIDC parameters forwarded from GET /api/oauth/authorize to the consent screen. */
const FORWARDED_PARAMS = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge', 'code_challenge_method'];

/**
 * SSO consent screen for the built-in OIDC provider.
 *
 * The API has already checked client_id + exact redirect_uri before sending the browser here; we
 * re-check via GET /api/oauth/clients/:id and only mint a code after the user clicks "Allow".
 * The code is requested with POST /api/oauth/authorize carrying the session in the Authorization
 * header (added by the auth interceptor) — the session JWT never appears in a URL.
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
          <h1 id="oa-title" class="oa-title">Single sign-on</h1>

          @switch (status) {
            @case ('loading') {
              <p class="oa-sub">Checking the application…</p>
              <div class="oa-spinner" role="status" aria-label="Loading"></div>
            }
            @case ('consent') {
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
  clientName = '';
  redirectHost = '';
  errorMessage = '';
  busy = false;

  private params: Record<string, string> = {};

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private http: HttpClient,
    private auth: AuthService,
  ) {}

  async ngOnInit() {
    const query = this.route.snapshot.queryParams || {};
    for (const key of FORWARDED_PARAMS) {
      if (typeof query[key] === 'string' && query[key]) this.params[key] = query[key];
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

    try {
      const info = await firstValueFrom(
        this.http.get<any>(`/api/oauth/clients/${encodeURIComponent(clientId)}`, { params: { redirect_uri: redirectUri } })
      );
      if (!info?.redirect_uri_valid) {
        return this.fail('This application is not allowed to use that redirect address.');
      }
      this.clientName = info.name || clientId;
      this.redirectHost = new URL(redirectUri).origin;
      this.status = 'consent';
    } catch {
      this.fail('Unknown application. Ask your administrator to register it.');
    }
  }

  async allow() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await firstValueFrom(this.http.post<{ redirect: string }>('/api/oauth/authorize', this.params));
      if (!res?.redirect) throw new Error('no redirect');
      this.navigateExternal(res.redirect);
    } catch (err: any) {
      this.busy = false;
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
