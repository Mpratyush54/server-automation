import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { isPublicMarketingHost } from './public-domain.guard';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  const auth = inject(AuthService);

  // Public marketing site never serves the authenticated app.
  if (isPublicMarketingHost()) {
    router.navigate(['/landing']);
    return false;
  }

  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');

  if (tokenFromUrl) {
    if (!auth.decodeToken(tokenFromUrl)?.id) {
      router.navigate(['/login']);
      return false;
    }
    localStorage.setItem('plat_auth_token', tokenFromUrl);
    try {
      const decoded = auth.decodeToken(tokenFromUrl);
      if (decoded) {
        localStorage.setItem('plat_user_profile', JSON.stringify(decoded));
      }
    } catch (e) {
      console.error('Failed to decode token from URL', e);
    }
    router.navigateByUrl(window.location.pathname);
    return auth.isAuthenticated();
  }

  if (auth.isAuthenticated()) {
    return true;
  }
  router.navigate(['/login']);
  return false;
};
export default authGuard;
