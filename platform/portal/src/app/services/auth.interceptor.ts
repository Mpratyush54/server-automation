import { HttpInterceptorFn } from '@angular/common/http';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  let token = localStorage.getItem('plat_auth_token');
  if (!token) {
    token = '33333333-3333-3333-3333-333333333333';
    localStorage.setItem('plat_auth_token', token);
  }
  
  const authReq = req.clone({
    setHeaders: {
      Authorization: `Bearer ${token}`,
    },
  });
  return next(authReq);
};
