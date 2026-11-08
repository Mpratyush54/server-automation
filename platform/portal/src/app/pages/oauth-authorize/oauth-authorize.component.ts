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
  template: `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #0D0F14; color: #fff; font-family: sans-serif; padding: 16px; box-sizing: border-box;">
      <div style="text-align: center; padding: 40px; background: #14171F; border: 1px solid #1C2030; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); max-width: 420px; width: 100%; box-sizing: border-box;">
        <span style="font-size: 3rem; margin-bottom: 20px; display: inline-block;">⚡</span>
        <h2 style="margin: 0 0 10px 0; font-size: 1.5rem; color: #fff;">Single sign-on</h2>
    
        @switch (status) {
          @case ('loading') {
            <div>
              <p style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 24px;">Checking the application…</p>
              <div class="spinner"></div>
            </div>
          }
          @case ('consent') {
            <div>
              <p style="color: #94a3b8; font-size: 0.9rem; margin-bottom: 8px; line-height: 1.5;">
                <strong style="color: #fff;">{{ clientName }}</strong> wants to sign you in with your Platform account.
              </p>
              <p style="color: #64748b; font-size: 0.8rem; margin-bottom: 8px; line-height: 1.5;">
                It will receive your name, email and role. You will be sent back to:
              </p>
              <p data-testid="redirect-host" style="color: #cbd5e1; font-size: 0.8rem; margin-bottom: 24px; word-break: break-all;">{{ redirectHost }}</p>
              <div style="display: flex; gap: 12px; justify-content: center;">
                <button type="button" class="btn-secondary" (click)="deny()" [disabled]="busy">Cancel</button>
                <button type="button" class="btn-primary" (click)="allow()" [disabled]="busy">Allow</button>
              </div>
            </div>
          }
          @case ('error') {
            <div>
              <p data-testid="oauth-error" style="color: #f87171; font-size: 0.9rem; margin-bottom: 24px; line-height: 1.5;">{{ errorMessage }}</p>
              <button type="button" class="btn-secondary" (click)="goHome()">Back to Platform</button>
            </div>
          }
        }
      </div>
    </div>
    `,
  styles: [`
    .spinner {
      border: 3px solid rgba(91, 110, 245, 0.1);
      border-top-color: #5b6ef5;
      border-radius: 50%;
      width: 36px;
      height: 36px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    .btn-primary, .btn-secondary {
      padding: 10px 22px;
      border-radius: 8px;
      font-size: 0.9rem;
      cursor: pointer;
      border: 1px solid #2a3042;
    }
    .btn-primary { background: #5b6ef5; color: #fff; border-color: #5b6ef5; }
    .btn-secondary { background: transparent; color: #cbd5e1; }
    button[disabled] { opacity: 0.6; cursor: default; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `]
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
