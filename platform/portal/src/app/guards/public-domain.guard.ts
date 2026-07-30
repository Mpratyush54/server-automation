import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';

/** True only on the public marketing site (landing + docs). */
export function isPublicMarketingHost(): boolean {
  const host = window.location.hostname;
  return host === 'platform.pratyushes.dev' || host.endsWith('.pratyushes.dev');
}

/**
 * Server / app hosts: block marketing pages (landing, docs).
 * Public marketing host: allow only those pages.
 */
export const marketingOnlyGuard: CanActivateFn = () => {
  if (isPublicMarketingHost()) {
    return true;
  }
  const router = inject(Router);
  router.navigate(['/login']);
  return false;
};

/**
 * App routes (login, dashboard, …): blocked on the public marketing host.
 */
export const appHostGuard: CanActivateFn = () => {
  if (!isPublicMarketingHost()) {
    return true;
  }
  const router = inject(Router);
  router.navigate(['/landing']);
  return false;
};
