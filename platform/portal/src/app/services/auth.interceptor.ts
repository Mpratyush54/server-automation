import { inject } from '@angular/core';
import { HttpContextToken, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

function clearSession(): void {
  localStorage.removeItem('plat_auth_token');
  localStorage.removeItem('plat_user_profile');
}

function isJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/**
 * Set on requests that carry their own credentials (e.g. the API playground):
 * the session JWT is not attached and a 401 does not end the session.
 */
export const SKIP_SESSION_AUTH = new HttpContextToken<boolean>(() => false);

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const token = localStorage.getItem('plat_auth_token');
  const isLogin = req.url.includes('/auth/login');
  // A caller-supplied Authorization header (agent token, another user's JWT)
  // must reach the API unchanged; only fill it in when it is absent.
  const usesOwnAuth = req.context.get(SKIP_SESSION_AUTH) || req.headers.has('Authorization');

  const authReq =
    token && isJwt(token) && !isLogin && !usesOwnAuth
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

  // MFA (#24): wrong codes and step-up prompts are answered with 401 but keep the session.
  const isMfaCall = req.url.includes('/auth/mfa/');

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      const apiError = (err.error as any)?.error;
      if (err.status === 403 && apiError === 'mfa_enrollment_required') {
        if (!router.url.startsWith('/mfa/enroll')) router.navigateByUrl('/mfa/enroll');
        return throwError(() => err);
      }
      const keepsSession = apiError === 'step_up_required' || isMfaCall;
      // A 401 for credentials the caller chose says nothing about the session.
      if (err.status === 401 && !isLogin && !usesOwnAuth && !keepsSession) {
        clearSession();
        if (!router.url.startsWith('/login')) {
          router.navigateByUrl('/login');
        }
      }
      return throwError(() => err);
    })
  );
};
