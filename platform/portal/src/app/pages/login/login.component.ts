import { Component, OnInit } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService, safeReturnUrl } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, RouterModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  email = '';
  password = '';
  showPassword = false;
  errorMessage = '';
  loading = false;
  /** Second step (#24): the password (or GitHub/GitLab) was accepted, MFA code required. */
  mfaStep = false;
  mfaCode = '';
  useRecoveryCode = false;
  providers = {
    github: { enabled: false, configured: false },
    gitlab: { enabled: false, configured: false, url: 'https://gitlab.com' },
  };

  constructor(
    private auth: AuthService,
    private router: Router,
    private route: ActivatedRoute,
    private api: ApiService,
  ) {}

  async ngOnInit() {
    const oauthError = this.route.snapshot.queryParams['error'];
    if (oauthError) {
      this.errorMessage = oauthError;
    }
    if (this.auth.isAuthenticated()) {
      this.goToApp();
      return;
    }
    // GitHub/GitLab login of a user with MFA: the exchange left a challenge for this step.
    if (this.auth.getPendingChallenge?.()) {
      this.mfaStep = true;
    }
    await this.loadProviders();
  }

  private goToApp() {
    if (this.auth.mfaEnrollmentRequired?.()) {
      this.router.navigate(['/mfa/enroll']);
      return;
    }
    const returnUrl = safeReturnUrl(this.route.snapshot.queryParams['returnUrl']);
    if (returnUrl) this.router.navigateByUrl(returnUrl);
    else this.router.navigate(['/dashboard']);
  }

  async verifyMfa() {
    const code = (this.mfaCode || '').trim();
    if (!code) {
      this.errorMessage = this.useRecoveryCode ? 'Enter a recovery code.' : 'Enter the 6-digit code from your authenticator app.';
      return;
    }
    this.errorMessage = '';
    this.loading = true;
    try {
      await this.auth.completeMfaChallenge(code);
      this.goToApp();
    } catch (err: any) {
      const apiError = err?.error?.error;
      if (apiError === 'invalid_challenge') {
        this.cancelMfa();
        this.errorMessage = 'Sign-in expired. Please sign in again.';
      } else if (err?.status === 429) {
        this.errorMessage = 'Too many attempts. Wait a few minutes and try again.';
      } else {
        this.errorMessage = 'That code is not valid (or was already used).';
      }
    } finally {
      this.mfaCode = '';
      this.loading = false;
    }
  }

  cancelMfa() {
    this.auth.setPendingChallenge?.(null);
    this.mfaStep = false;
    this.mfaCode = '';
    this.useRecoveryCode = false;
    this.password = '';
  }

  async loadProviders() {
    try {
      this.providers = await firstValueFrom(this.api.getAuthProviders());
    } catch {
      this.providers = {
        github: { enabled: false, configured: false },
        gitlab: { enabled: false, configured: false, url: 'https://gitlab.com' },
      };
    }
  }

  async login() {
    this.errorMessage = '';
    this.loading = true;

    try {
      const ident = (this.email || '').trim();
      if (!ident) {
        this.errorMessage = 'Please enter your email or username.';
        this.loading = false;
        return;
      }
      if (!this.password || this.password.length < 1) {
        this.errorMessage = 'Please enter your password.';
        this.loading = false;
        return;
      }
      const res = ident.includes('@')
        ? await firstValueFrom(this.auth.login(ident, this.password))
        : await firstValueFrom(this.auth.login('', this.password, ident));

      if (res?.mfa_required) {
        this.mfaStep = true;
        return;
      }
      if (res?.mfaEnrollmentRequired) {
        this.router.navigate(['/mfa/enroll']);
        return;
      }
      this.goToApp();
    } catch (err: any) {
      this.errorMessage = err.error?.error || 'Authentication failed. Please check your credentials.';
    } finally {
      this.loading = false;
    }
  }

  loginWithGitHub() {
    if (!this.providers.github?.enabled) return;
    window.location.href = '/api/auth/github';
  }

  loginWithGitLab() {
    if (!this.providers.gitlab?.enabled) return;
    window.location.href = '/api/auth/gitlab';
  }
}
