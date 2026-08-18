import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css'
})
export class LoginComponent implements OnInit {
  email = '';
  password = '';
  showPassword = false;
  errorMessage = '';
  loading = false;
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
      this.router.navigate(['/dashboard']);
      return;
    }
    await this.loadProviders();
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
      if (ident.includes('@')) {
        await firstValueFrom(this.auth.login(ident, this.password));
      } else {
        await firstValueFrom(this.auth.login('', this.password, ident));
      }

      const returnUrl = this.route.snapshot.queryParams['returnUrl'];
      if (returnUrl) {
        this.router.navigateByUrl(returnUrl);
      } else {
        this.router.navigate(['/dashboard']);
      }
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
