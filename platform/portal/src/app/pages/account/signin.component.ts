import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { LicenseAccountService } from './license-account.service';

@Component({
  selector: 'app-signin',
  standalone: true,
  imports: [FormsModule, RouterModule, SiteHeaderComponent, SiteFooterComponent],
  styleUrl: './site-page.css',
  template: `
    <app-site-header></app-site-header>
    <main class="sp" id="main">
      <section class="sp-section">
        <div class="sp-frame sp-narrow">
          <h1 class="sp-display">Sign in</h1>
          <p class="sp-lede">Manage your license keys and installs.</p>
          <form class="sp-form" (ngSubmit)="submit()" #f="ngForm">
            <div class="sp-field"><label for="si-email">Email</label><input id="si-email" name="email" type="email" [(ngModel)]="email" required autocomplete="email"></div>
            <div class="sp-field"><label for="si-password">Password</label><input id="si-password" name="password" type="password" [(ngModel)]="password" required autocomplete="current-password"></div>
            <div class="sp-actions">
              <button type="submit" class="btn btn-primary" [disabled]="!f.valid || busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
              <a routerLink="/signup">Create an account</a>
            </div>
          </form>
          @if (unverified) {
            <p class="sp-msg" role="alert" data-testid="signin-unverified">Confirm your email address first.
              <button type="button" class="btn btn-sm" (click)="resend()">Send the link again</button></p>
          }
          @if (error) { <p class="sp-msg sp-err" role="alert">{{ error }}</p> }
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
})
export class SigninComponent {
  private api = inject(LicenseAccountService);
  private router = inject(Router);
  email = '';
  password = '';
  busy = false;
  error = '';
  unverified = false;

  async submit() {
    this.busy = true;
    this.error = '';
    this.unverified = false;
    try {
      await this.api.signin(this.email.trim(), this.password);
      this.password = '';
      await this.router.navigateByUrl('/account');
    } catch (e: any) {
      if (e?.code === 'email_not_verified') this.unverified = true;
      else this.error = e?.status === 401 || e?.status === 403 ? 'Email or password is wrong.' : (e?.message || 'Could not sign in.');
    } finally {
      this.busy = false;
    }
  }

  async resend() {
    try {
      await this.api.resend(this.email.trim());
      this.unverified = false;
    } catch (e: any) {
      this.error = e?.message || 'Could not send the email.';
    }
  }
}
