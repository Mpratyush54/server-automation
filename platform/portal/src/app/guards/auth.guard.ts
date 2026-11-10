import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { isPublicMarketingHost } from './public-domain.guard';
import { AuthService } from '../services/auth.service';

/**
 * Session tokens are never accepted from the URL. After GitHub/GitLab login the API redirects to
 * `/dashboard?code=<one-time code>`, which is swapped for a session over POST /api/auth/exchange.
 * Roles always come from the API profile (/api/users/me), not from client-decoded JWT claims.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = inject(AuthService);

  // Public marketing site never serves the authenticated app.
  if (isPublicMarketingHost()) {
    return router.createUrlTree(['/']);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const loginCode = urlParams.get('code');
  if (urlParams.has('token') || loginCode) {
    // Strip credentials from the address bar / history before anything else runs.
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    clean.searchParams.delete('code');
    window.history.replaceState(window.history.state, '', clean.pathname + clean.search + clean.hash);
  }

  if (loginCode) {
    auth.clearSession();
    const ok = await auth.exchangeLoginCode(loginCode);
    if (ok === 'mfa_required') {
      return router.createUrlTree(['/login'], { queryParams: { mfa: '1' } });
    }
    if (!ok) {
      return router.createUrlTree(['/login'], { queryParams: { error: 'Sign-in link expired. Please sign in again.' } });
    }
    if (auth.mfaEnrollmentRequired()) return router.createUrlTree(['/mfa/enroll']);
    const target = (state?.url || window.location.pathname).split('?')[0];
    return router.parseUrl(target || '/dashboard');
  }

  if (!auth.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }

  // Role requires MFA but none is enrolled: the session only reaches the enrolment screen (#24).
  if (auth.mfaEnrollmentRequired()) {
    return router.createUrlTree(['/mfa/enroll']);
  }

  if (!auth.profileVerified) {
    const ok = await auth.loadProfile();
    if (!ok && !auth.isAuthenticated()) {
      return router.createUrlTree(['/login']);
    }
  }
  return true;
};
export default authGuard;
