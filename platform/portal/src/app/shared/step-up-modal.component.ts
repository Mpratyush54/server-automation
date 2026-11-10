import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Subscription, firstValueFrom } from 'rxjs';
import { StepUpRequest, StepUpService } from '../services/step-up.service';
import { MfaService } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';

/** Global modal that asks for a TOTP (or recovery) code when an action needs step-up (#24). */
@Component({
  selector: 'app-step-up-modal',
  standalone: true,
  imports: [FormsModule, RouterModule],
  template: `
@if (request) {
  <div class="modal-overlay step-up-overlay" style="position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:1000;">
    <div class="card step-up-modal" role="dialog" aria-modal="true" aria-labelledby="step-up-title" style="width:min(420px, calc(100vw - 32px)); padding:24px;">
      <h2 id="step-up-title" style="margin:0 0 6px;">{{ request.reason }}</h2>
      @if (notEnrolled) {
        <p class="step-up-enrol" style="color:var(--text-secondary); font-size:0.85rem;">
          This action needs two-factor authentication. Set up an authenticator app on your profile first.
        </p>
        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
          <button class="btn" type="button" (click)="cancel()">Cancel</button>
          <a class="btn btn-primary" routerLink="/profile" (click)="cancel()">Set up on profile</a>
        </div>
      } @else {
        <p style="color:var(--text-secondary); font-size:0.85rem; margin:0 0 14px;">
          Enter the 6-digit code from your authenticator app, or a recovery code.
        </p>
        <form (ngSubmit)="submit()">
          <input class="step-up-code" name="code" [(ngModel)]="code" autocomplete="one-time-code" inputmode="numeric"
                 placeholder="123456" aria-label="Authentication code" style="width:100%; box-sizing:border-box; font-size:1.2rem; letter-spacing:0.2em; text-align:center;">
          @if (error) {
            <div class="step-up-error" style="color:var(--accent-danger); font-size:0.8rem; margin-top:8px;">{{ error }}</div>
          }
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
            <button class="btn" type="button" (click)="cancel()">Cancel</button>
            <button class="btn btn-primary step-up-submit" type="submit" [disabled]="busy || !code.trim()">{{ busy ? 'Verifying…' : 'Verify' }}</button>
          </div>
        </form>
      }
    </div>
  </div>
}
`,
})
export class StepUpModalComponent implements OnInit, OnDestroy {
  request: StepUpRequest | null = null;
  code = '';
  error = '';
  busy = false;
  notEnrolled = false;
  private sub?: Subscription;

  constructor(private stepUp: StepUpService, private mfa: MfaService, private auth: AuthService) {}

  ngOnInit() {
    this.sub = this.stepUp.request$.subscribe((r) => {
      this.request = r;
      this.code = '';
      this.error = '';
      this.busy = false;
      this.notEnrolled = false;
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  async submit() {
    if (!this.request || !this.code.trim()) return;
    this.busy = true;
    this.error = '';
    try {
      const res = await firstValueFrom(this.mfa.stepUp(this.code.trim()));
      this.auth.replaceSession(res);
      this.request.resolve(true);
    } catch (err: any) {
      const code = err?.error?.error;
      if (code === 'mfa_not_enrolled') {
        this.notEnrolled = true;
      } else if (code === 'too_many_attempts' || err?.status === 429) {
        this.error = 'Too many attempts. Wait a few minutes and try again.';
      } else {
        this.error = 'That code is not valid (or was already used).';
      }
      this.code = '';
    } finally {
      this.busy = false;
    }
  }

  cancel() {
    this.request?.resolve(false);
  }
}
