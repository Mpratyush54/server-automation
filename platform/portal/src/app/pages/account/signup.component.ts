import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { LicenseAccountService } from './license-account.service';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [FormsModule, RouterModule, SiteHeaderComponent, SiteFooterComponent],
  styleUrl: './site-page.css',
  template: `
    <app-site-header></app-site-header>
    <main class="sp" id="main">
      <section class="sp-section">
        <div class="sp-frame sp-narrow">
          <h1 class="sp-display">Get a free key</h1>
          @if (sent) {
            <p class="sp-lede" data-testid="signup-sent">Check your inbox. We sent a link to {{ email }}. Open it to confirm your address and see your license key.</p>
            <div class="sp-actions">
              <button type="button" class="btn" (click)="resend()" [disabled]="busy">Send the email again</button>
            </div>
          } @else {
            <p class="sp-lede">Create an account for a free Personal license key.</p>
            <form class="sp-form" (ngSubmit)="submit()" #f="ngForm">
              <div class="sp-field"><label for="su-email">Email</label><input id="su-email" name="email" type="email" [(ngModel)]="email" required email autocomplete="email"></div>
              <div class="sp-field">
                <label for="su-password">Password</label>
                <input id="su-password" name="password" type="password" [(ngModel)]="password" required minlength="12" autocomplete="new-password">
                <span class="sp-muted">At least 12 characters.</span>
              </div>
              <p class="sp-muted">Privacy notice: coming soon.</p>
              <div class="sp-actions">
                <button type="submit" class="btn btn-primary" [disabled]="!f.valid || busy">{{ busy ? 'Creating account…' : 'Create account' }}</button>
                <a routerLink="/signin">I already have an account</a>
              </div>
            </form>
          }
          @if (error) { <p class="sp-msg sp-err" role="alert">{{ error }}</p> }
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
})
export class SignupComponent {
  private api = inject(LicenseAccountService);
  email = '';
  password = '';
  busy = false;
  sent = false;
  error = '';

  async submit() {
    this.busy = true;
    this.error = '';
    try {
      await this.api.signup(this.email.trim(), this.password);
      this.password = '';
      this.sent = true;
    } catch (e: any) {
      this.error = e?.message || 'Could not create the account.';
    } finally {
      this.busy = false;
    }
  }

  async resend() {
    this.busy = true;
    try {
      await this.api.resend(this.email.trim());
    } catch (e: any) {
      this.error = e?.message || 'Could not send the email.';
    }
    this.busy = false;
  }
}
