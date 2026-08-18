import { inject } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

function clearSession(): void {
  localStorage.removeItem('plat_auth_token');
  localStorage.removeItem('plat_user_profile');
}

function isJwt(token: string): boolean {
  return token.split('.').length === 3;
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const token = localStorage.getItem('plat_auth_token');
  const isLogin = req.url.includes('/auth/login');

  const authReq =
    token && isJwt(token) && !isLogin
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req;

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !isLogin) {
        clearSession();
        if (!router.url.startsWith('/login')) {
          router.navigateByUrl('/login');
        }
      }
      return throwError(() => err);
    })
  );
};
