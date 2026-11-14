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
  styleUrl: './mfa-enroll.component.css',
  template: `
<main class="mfe-page">
  <div class="mfe-panel">
    <section class="mfe-card mfa-enroll-page" aria-labelledby="mfe-title">
      <h1 id="mfe-title" class="mfe-title">Set up two-factor authentication</h1>
      <p class="mfe-sub">
        Your role ({{ role }}) requires two-factor authentication. Finish this step to continue to the portal.
      </p>
      <app-mfa-enrollment [account]="email" (completed)="done()"></app-mfa-enrollment>
      <div class="mfe-foot">
        <button class="btn btn-ghost btn-sm mfa-signout" type="button" (click)="signOut()">Sign out</button>
      </div>
    </section>
  </div>
</main>
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
