import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';

/**
 * Exact hostnames that serve the public marketing site (landing + docs).
 * Any other host — including other *.pratyushes.dev names such as an app or
 * portal subdomain — is an app host. Add hosts here to serve marketing pages
 * from additional domains.
 */
export const MARKETING_HOSTS: readonly string[] = ['platform.pratyushes.dev'];

/** True only on the public marketing site (landing + docs). */
export function isPublicMarketingHost(
  host = window.location.hostname,
  marketingHosts: readonly string[] = MARKETING_HOSTS,
): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return marketingHosts.includes(normalized);
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
  router.navigate(['/']);
  return false;
};
