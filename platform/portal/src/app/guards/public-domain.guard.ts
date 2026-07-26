import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';

export const publicDomainGuard: CanActivateFn = () => {
  if (window.location.hostname === 'platform.pratyushes.dev') {
    const router = inject(Router);
    router.navigate(['/landing']);
    return false;
  }
  return true;
};
