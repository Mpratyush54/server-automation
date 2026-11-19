import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { SiteHeaderComponent } from '../../shared/site/site-header.component';
import { SiteFooterComponent } from '../../shared/site/site-footer.component';
import { ToastService } from '../../shared/feedback/feedback.service';
import { LicenseAccountService } from './license-account.service';

@Component({
  selector: 'app-verify-email',
  standalone: true,
  imports: [RouterModule, SiteHeaderComponent, SiteFooterComponent],
  styleUrl: './site-page.css',
  template: `
    <app-site-header></app-site-header>
    <main class="sp" id="main">
      <section class="sp-section">
        <div class="sp-frame sp-narrow">
          <h1 class="sp-display">Confirm your email</h1>
          @if (state === 'working') {
            <p class="sp-lede">Confirming…</p>
          } @else if (state === 'done') {
            <p class="sp-lede">Your email address is confirmed.</p>
            @if (key) {
              <p class="sp-text">This is your license key. Copy it now: it is shown only once.</p>
              <div class="sp-secret" data-testid="license-key">{{ key }}</div>
              <div class="sp-actions">
                <button type="button" class="btn btn-primary" (click)="copy()">Copy key</button>
                <a class="btn" routerLink="/docs/getting-started/installation">Install Cairn</a>
              </div>
              <p class="sp-muted">Enter it when the installer asks, or save it to a file and run <span class="sp-mono">sudo platformctl license activate --license-key-file FILE</span>.</p>
            } @else {
              <div class="sp-actions"><a class="btn btn-primary" routerLink="/account">Go to your account</a></div>
            }
          } @else {
            <p class="sp-msg sp-err" role="alert">{{ error }}</p>
            <div class="sp-actions"><a class="btn" routerLink="/signin">Sign in</a></div>
          }
        </div>
      </section>
    </main>
    <app-site-footer></app-site-footer>
  `,
})
export class VerifyEmailComponent implements OnInit {
  private api = inject(LicenseAccountService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  state: 'working' | 'done' | 'failed' = 'working';
  key = '';
  error = '';

  async ngOnInit() {
    const token = this.route.snapshot.queryParamMap.get('token') || '';
    // Keep the token out of the address bar and history.
    void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
    if (!token) {
      this.state = 'failed';
      this.error = 'This link is incomplete. Open the link from the email again.';
      return;
    }
    try {
      const res = await this.api.verify(token);
      this.key = res?.license_key || '';
      this.state = 'done';
    } catch (e: any) {
      this.state = 'failed';
      this.error = [400, 404, 410].includes(e?.status)
        ? 'This link has expired or was already used. Sign in to see your account.'
        : (e?.message || 'Could not confirm your email.');
    }
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.key);
      this.toast.show('Key copied', 'ok');
    } catch {
      this.toast.error('Could not copy. Select the key and copy it.');
    }
  }
}
