import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { isPublicMarketingHost } from './public-domain.guard';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);

  // Public marketing site never serves the authenticated app.
  if (isPublicMarketingHost()) {
    router.navigate(['/landing']);
    return false;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');

  if (tokenFromUrl) {
    localStorage.setItem('plat_auth_token', tokenFromUrl);
    try {
      const parts = tokenFromUrl.split('.');
      if (parts.length === 3) {
        const decoded = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        localStorage.setItem('plat_user_profile', JSON.stringify(decoded));
      }
    } catch (e) {
      console.error('Failed to decode token from URL', e);
    }
    router.navigateByUrl(window.location.pathname);
    return true;
  }

  const token = localStorage.getItem('plat_auth_token');
  if (token) {
    return true;
  }
  router.navigate(['/login']);
  return false;
};
export default authGuard;
