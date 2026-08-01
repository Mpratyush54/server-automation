import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, tap } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private base = '/api';

  constructor(private http: HttpClient, private router: Router) {}

  login(email: string, password: string, username?: string): Observable<any> {
    const body: any = { password };
    if (username) {
      body.username = username;
    } else {
      body.email = email;
    }
    return this.http.post<any>(`${this.base}/auth/login`, body).pipe(
      tap(res => {
        if (res.token) {
          localStorage.setItem('plat_auth_token', res.token);
          const decoded = this.decodeToken(res.token);
          localStorage.setItem('plat_user_profile', JSON.stringify(decoded));
        }
      })
    );
  }

  logout() {
    localStorage.removeItem('plat_auth_token');
    localStorage.removeItem('plat_user_profile');
    this.router.navigate(['/login']);
  }

  getToken(): string | null {
    return localStorage.getItem('plat_auth_token');
  }

  getUser(): any {
    const profile = localStorage.getItem('plat_user_profile');
    return profile ? JSON.parse(profile) : null;
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
