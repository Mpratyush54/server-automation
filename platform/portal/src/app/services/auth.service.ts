import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, firstValueFrom, tap } from 'rxjs';

/** Only same-origin, app-relative return URLs are honoured after login (no open redirects). */
export function safeReturnUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private base = '/api';

  constructor(private http: HttpClient, private router: Router) {}

  login(email: string, password: string, username?: string): Observable<any> {
    const body: any = { password };
    if (username) {
      body.username = username.trim();
    } else {
      body.email = email.trim();
    }
    return this.http.post<any>(`${this.base}/auth/login`, body).pipe(
      tap(res => this.storeSession(res))
    );
  }

  /**
   * Swap the one-time `?code=` from the GitHub/GitLab callback for a session (POST, never a URL token).
   * Resolves false when the code is invalid, expired or already used.
   */
  async exchangeLoginCode(code: string): Promise<boolean> {
    try {
      const res = await firstValueFrom(this.http.post<any>(`${this.base}/auth/exchange`, { code }));
      if (!res?.token || !res?.user) return false;
      this.storeSession(res);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reload the profile (role, permissions) from the API. Roles shown in the UI always come from the
   * server, never from client-decoded JWT claims. Resolves false if the session is rejected.
   */
  async loadProfile(): Promise<boolean> {
    try {
      const user = await firstValueFrom(this.http.get<any>(`${this.base}/users/me`));
      if (!user?.id) return false;
      localStorage.setItem('plat_user_profile', JSON.stringify(user));
      this.profileVerified = true;
      return true;
    } catch {
      return false;
    }
  }

  /** True once the profile has been loaded from the API during this page load. */
  profileVerified = false;

  private storeSession(res: { token?: string; user?: any }) {
    if (!res?.token) return;
    localStorage.setItem('plat_auth_token', res.token);
    if (res.user) {
      localStorage.setItem('plat_user_profile', JSON.stringify(res.user));
      this.profileVerified = true;
    } else {
      // Legacy response without a user object: keep only the id; role is loaded from /users/me.
      const decoded = this.decodeToken(res.token);
      localStorage.setItem('plat_user_profile', JSON.stringify({ id: decoded?.id }));
      this.profileVerified = false;
    }
  }

  logout() {
    this.clearSession();
    this.router.navigate(['/login']);
  }

  clearSession() {
    localStorage.removeItem('plat_auth_token');
    localStorage.removeItem('plat_user_profile');
    this.profileVerified = false;
  }

  getToken(): string | null {
    return localStorage.getItem('plat_auth_token');
  }

  /** True only for a real, unexpired JWT — not leftover dummy/passwordless tokens. */
  isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) return false;
    const decoded = this.decodeToken(token);
    if (!decoded?.id) {
      this.clearSession();
      return false;
    }
    if (typeof decoded.exp === 'number' && decoded.exp * 1000 < Date.now()) {
      this.clearSession();
      return false;
    }
    return true;
  }

  getUser(): any {
    const profile = localStorage.getItem('plat_user_profile');
    return profile ? JSON.parse(profile) : null;
  }

  setUser(user: any) {
    const current = this.getUser() || {};
    localStorage.setItem('plat_user_profile', JSON.stringify({ ...current, ...user }));
  }

  getRole(): string {
    const user = this.getUser();
    return user ? user.role : 'developer';
  }

  isDevOps(): boolean {
    return this.getRole() === 'devops';
  }

  isAdmin(): boolean {
    return this.getRole() === 'admin';
  }

  /** Admin or DevOps can manage users / infra settings */
  canManageUsers(): boolean {
    const role = this.getRole();
    return role === 'admin' || role === 'devops';
  }

  isTechLead(): boolean {
    return this.getRole() === 'tech_lead';
  }

  isTechLeadOrDevOps(): boolean {
    const role = this.getRole();
    return role === 'tech_lead' || role === 'devops' || role === 'admin';
  }

  decodeToken(token: string): any {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = parts[1];
      const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }
}
