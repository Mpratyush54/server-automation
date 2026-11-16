import { inject, isDevMode } from '@angular/core';
import { Router, CanActivateFn, RouterStateSnapshot, ActivatedRouteSnapshot } from '@angular/router';

/**
 * Exact hostnames that serve the public marketing site (landing + docs).
 * Any other host — including other subdomains such as an app or
 * portal subdomain — is an app host. Add hosts here to serve marketing pages
 * from additional domains.
 */
export const MARKETING_HOSTS: readonly string[] = ['cairnpaas.dev', 'platform.pratyushes.dev'];

/** True only on the public marketing site (landing + docs). */
export function isPublicMarketingHost(
  host = window.location.hostname,
  marketingHosts: readonly string[] = MARKETING_HOSTS,
): boolean {
  const normalized = host.toLowerCase().replace(/\.$/, '');
  // Local preview of the public site in development builds only.
  if (isDevMode() && normalized === 'platform.localhost') return true;
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

/** Where the public docs live. App hosts send /docs links here. */
export const PUBLIC_DOCS_ORIGIN = 'https://cairnpaas.dev';

/** Same docs page on the public site, keeping path, query and fragment. */
export function publicDocsUrl(appUrl: string, origin = PUBLIC_DOCS_ORIGIN): string {
  const path = appUrl.startsWith('/') ? appUrl : '/' + appUrl;
  return origin + (path.startsWith('/docs') ? path : '/docs');
}

/**
 * Docs: shown on the public marketing host; on app hosts the browser goes to
 * the same page on the public site instead of the sign-in page.
 */
export const docsGuard: CanActivateFn = (_route: ActivatedRouteSnapshot, state: RouterStateSnapshot) => {
  if (isPublicMarketingHost()) return true;
  window.location.replace(publicDocsUrl(state.url));
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
