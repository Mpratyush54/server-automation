import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { MfaEnrollmentComponent } from '../../shared/mfa-enrollment.component';
import { AuthService } from '../../services/auth.service';

/**
 * Forced enrolment (#24): users whose role is in `mfa.requiredRoles` and who have no
 * authenticator land here after signing in. Their session reaches nothing else until they enrol.
 */
@Component({
  selector: 'app-mfa-enroll',
  standalone: true,
  imports: [MfaEnrollmentComponent],
  template: `
<div class="min-h-screen flex items-center justify-center p-4" style="min-height:100vh; display:flex; align-items:center; justify-content:center;">
  <div class="card mfa-enroll-page" style="width:min(560px, calc(100vw - 32px)); padding:28px;">
    <h1 style="margin:0 0 6px; font-size:1.3rem;">Set up two-factor authentication</h1>
    <p style="color:var(--text-secondary); font-size:0.85rem; margin:0 0 18px;">
      Your role ({{ role }}) requires two-factor authentication. Finish this step to continue to the portal.
    </p>
    <app-mfa-enrollment [account]="email" (completed)="done()"></app-mfa-enrollment>
    <div style="margin-top:18px; text-align:right;">
      <button class="btn btn-sm mfa-signout" type="button" (click)="signOut()">Sign out</button>
    </div>
  </div>
</div>
`,
})
export class MfaEnrollComponent implements OnInit {
  role = '';
  email = '';

  constructor(private auth: AuthService, private router: Router) {}

  ngOnInit() {
    if (!this.auth.isAuthenticated()) {
      this.router.navigate(['/login']);
      return;
    }
    const user = this.auth.getUser() || {};
    this.role = user.role || 'admin';
    this.email = user.email || '';
  }

  done() {
    this.router.navigate(['/dashboard']);
  }

  signOut() {
    this.auth.logout();
  }
}
