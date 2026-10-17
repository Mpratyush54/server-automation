import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { isPublicMarketingHost } from './public-domain.guard';

/** Render the public homepage in place; retain app-host login/dashboard routing. */
export const homeGuard: CanActivateFn = () => {
  if (isPublicMarketingHost(inject(DOCUMENT).location.hostname)) return true;
  const router = inject(Router);
  const auth = inject(AuthService);
  return router.createUrlTree([
    auth.isAuthenticated() ? '/dashboard' : '/login',
  ]);
};

/** Old bookmarks retain their section and query when moved to the canonical root. */
export const legacyLandingGuard: CanActivateFn = (route) =>
  inject(Router).createUrlTree(['/'], {
    queryParams: route.queryParams,
    fragment: route.fragment ?? undefined,
  });
