import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  
  // Extract token from URL if redirected from OAuth callback
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
    
    // Redirect to clean path without query parameters
    const cleanUrl = window.location.pathname;
    router.navigateByUrl(cleanUrl);
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
