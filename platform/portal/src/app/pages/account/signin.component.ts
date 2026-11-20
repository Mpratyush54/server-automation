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
  styleUrls: ['./site-page.css', './signin.component.css'],
  template: `
    <app-site-header></app-site-header>
    <main class="sp" id="main">
      <section class="sp-hero si-hero">
        <div class="sp-frame si-grid">
          <div class="si-intro">
            <p class="si-kicker">Cairn account</p>
            <h1 class="sp-display">Sign in</h1>
            <p class="sp-lede">Manage your license keys and installs, license servers without internet access, and see the data we hold about you.</p>
            <ul class="si-points">
              <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span>Create, rotate or revoke your keys</span></li>
              <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span>See every install and free a slot</span></li>
              <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span>Read or download everything stored about you</span></li>
            </ul>
          </div>

          <div class="si-card">
            <form class="sp-form" (ngSubmit)="submit()" #f="ngForm" aria-labelledby="si-title">
              <h2 id="si-title" class="si-title">Sign in to your account</h2>
              <div class="sp-field"><label for="si-email">Email</label><input id="si-email" name="email" type="email" [(ngModel)]="email" required autocomplete="email"></div>
              <div class="sp-field"><label for="si-password">Password</label><input id="si-password" name="password" type="password" [(ngModel)]="password" required autocomplete="current-password"></div>
              @if (unverified) {
                <div class="si-note" role="alert" data-testid="signin-unverified">
                  <p class="sp-msg">Confirm your email address first. We sent you a link when you signed up.</p>
                  <button type="button" class="btn btn-sm" (click)="resend()">Send the link again</button>
                </div>
              }
              @if (resent) { <p class="sp-msg sp-ok" role="status" data-testid="signin-resent">If that address has an unconfirmed account, a new link is on its way.</p> }
              @if (error) { <p class="sp-msg sp-err" role="alert">{{ error }}</p> }
              <button type="submit" class="btn btn-primary si-submit" [disabled]="!f.valid || busy">{{ busy ? 'Signing in…' : 'Sign in' }}</button>
            </form>
            <p class="si-alt">New to Cairn? <a routerLink="/signup">Create a free account</a></p>
            <p class="si-legal">By signing in you agree to the <a routerLink="/terms">Terms of Service</a>. See how we handle your data in the <a routerLink="/privacy">Privacy Policy</a>.</p>
          </div>
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
  resent = false;

  async submit() {
    this.busy = true;
    this.error = '';
    this.unverified = false;
    this.resent = false;
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
      this.resent = true;
    } catch (e: any) {
      this.error = e?.message || 'Could not send the email.';
    }
  }
}
