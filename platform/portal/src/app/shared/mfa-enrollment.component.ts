import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { MfaEnrollment, MfaService, downloadRecoveryCodes } from '../services/mfa.service';
import { AuthService } from '../services/auth.service';

/**
 * TOTP enrolment (#24): QR code from the otpauth URI, verify step, then the recovery codes
 * (download / copy, shown once). Used by the profile page and the forced-enrolment screen.
 */
@Component({
  selector: 'app-mfa-enrollment',
  standalone: true,
  imports: [FormsModule],
  template: `
<div class="mfa-enrollment">
  @switch (step) {
    @case ('start') {
      <p style="color:var(--text-secondary); font-size:0.85rem; margin:0 0 12px;">
        Use an authenticator app (1Password, Bitwarden, Google Authenticator, Aegis…) to generate sign-in codes.
      </p>
      <button class="btn btn-primary mfa-start" type="button" (click)="start()" [disabled]="busy">{{ busy ? 'Preparing…' : 'Set up authenticator' }}</button>
    }
    @case ('scan') {
      <ol style="padding-left:18px; color:var(--text-secondary); font-size:0.85rem; margin:0 0 12px;">
        <li>Scan this QR code with your authenticator app.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start;">
        <img class="mfa-qr" [src]="enrollment!.qrDataUrl" alt="QR code for your authenticator app" width="200" height="200" style="background:#fff; border-radius:8px; padding:6px;">
        <div style="flex:1; min-width:200px;">
          <div style="font-size:0.75rem; color:var(--text-muted);">Can't scan? Enter this key manually:</div>
          <code class="mfa-secret" style="display:block; word-break:break-all; font-size:0.85rem; margin:4px 0 14px;">{{ enrollment!.secret }}</code>
          <form (ngSubmit)="verify()">
            <label for="mfa-code" style="font-size:0.8rem;">Code from the app</label>
            <input id="mfa-code" class="mfa-code" name="code" [(ngModel)]="code" autocomplete="one-time-code" inputmode="numeric"
                   maxlength="7" placeholder="123456" style="width:100%; box-sizing:border-box; letter-spacing:0.2em;">
            <button class="btn btn-primary mfa-verify" type="submit" [disabled]="busy || !code.trim()" style="margin-top:10px;">{{ busy ? 'Verifying…' : 'Verify and enable' }}</button>
          </form>
        </div>
      </div>
    }
    @case ('codes') {
      <p style="font-size:0.85rem; margin:0 0 8px;"><strong>Two-factor authentication is on.</strong> Save these recovery codes now — they are shown only once. Each code works once if you lose your device.</p>
      <ul class="mfa-recovery-codes" style="columns:2; list-style:none; padding:12px; margin:0 0 12px; font-family:var(--font-code); background:rgba(0,0,0,0.2); border-radius:6px;">
        @for (c of recoveryCodes; track c) {
          <li>{{ c }}</li>
        }
      </ul>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn mfa-download" type="button" (click)="download()">Download</button>
        <button class="btn" type="button" (click)="copy()">{{ copied ? 'Copied' : 'Copy' }}</button>
        <button class="btn btn-primary mfa-done" type="button" (click)="finish()" [disabled]="!saved">I saved my codes</button>
      </div>
    }
  }
  @if (error) {
    <div class="mfa-error" style="color:var(--accent-danger); font-size:0.8rem; margin-top:8px;">{{ error }}</div>
  }
</div>
`,
})
export class MfaEnrollmentComponent {
  @Input() account = '';
  /** Emitted after the recovery codes were saved. */
  @Output() completed = new EventEmitter<void>();

  step: 'start' | 'scan' | 'codes' = 'start';
  enrollment: MfaEnrollment | null = null;
  recoveryCodes: string[] = [];
  code = '';
  busy = false;
  error = '';
  copied = false;
  saved = false;

  constructor(private mfa: MfaService, private auth: AuthService) {}

  async start() {
    this.busy = true;
    this.error = '';
    try {
      this.enrollment = await firstValueFrom(this.mfa.enroll());
      this.step = 'scan';
    } catch (err: any) {
      this.error = err?.error?.message || err?.error?.error || 'Could not start enrolment.';
    } finally {
      this.busy = false;
    }
  }

  async verify() {
    if (!this.code.trim()) return;
    this.busy = true;
    this.error = '';
    try {
      const res = await firstValueFrom(this.mfa.verify(this.code.trim()));
      // The new session lifts the enrolment-only restriction and counts as a fresh second factor.
      this.auth.replaceSession(res);
      this.recoveryCodes = res.recoveryCodes || [];
      this.step = 'codes';
    } catch (err: any) {
      this.error = err?.status === 429
        ? 'Too many attempts. Wait a few minutes and try again.'
        : 'That code is not valid. Check that the time on your device is correct and try again.';
    } finally {
      this.code = '';
      this.busy = false;
    }
  }

  download() {
    downloadRecoveryCodes(this.recoveryCodes, this.account || this.enrollment?.account || '');
    this.saved = true;
  }

  async copy() {
    try {
      await navigator.clipboard.writeText(this.recoveryCodes.join('\n'));
      this.copied = true;
      this.saved = true;
    } catch {
      this.error = 'Copy failed — use Download instead.';
    }
  }

  finish() {
    this.completed.emit();
  }
}
