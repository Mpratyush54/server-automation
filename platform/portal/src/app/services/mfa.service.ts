import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface MfaStatus {
  enabled: boolean;
  pending: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  requiredRoles: string[];
  stepUpMaxAgeSec: number;
  session?: { amr: string[]; authTime: number | null; enrollmentOnly: boolean };
}

export interface MfaEnrollment {
  otpauthUri: string;
  qrDataUrl: string;
  secret: string;
  issuer: string;
  account?: string;
}

export interface MfaPolicy {
  requiredRoles: string[];
  source: 'setting' | 'env' | 'default';
  defaultRequiredRoles?: string[];
  stepUpMaxAgeSec?: number;
}

/** TOTP MFA endpoints (#24). */
@Injectable({ providedIn: 'root' })
export class MfaService {
  private base = '/api';

  constructor(private http: HttpClient) {}

  status(): Observable<MfaStatus> { return this.http.get<MfaStatus>(`${this.base}/auth/mfa/status`); }
  enroll(): Observable<MfaEnrollment> { return this.http.post<MfaEnrollment>(`${this.base}/auth/mfa/enroll`, {}); }
  verify(code: string): Observable<{ recoveryCodes: string[]; token: string; user: any }> {
    return this.http.post<any>(`${this.base}/auth/mfa/verify`, { code });
  }
  challenge(challengeToken: string, code: string): Observable<{ token: string; user: any; recoveryCodesRemaining?: number }> {
    return this.http.post<any>(`${this.base}/auth/mfa/challenge`, { challengeToken, code });
  }
  stepUp(code: string): Observable<{ token: string; user: any; maxAgeSec: number }> {
    return this.http.post<any>(`${this.base}/auth/mfa/step-up`, { code });
  }
  regenerateRecoveryCodes(code: string): Observable<{ recoveryCodes: string[] }> {
    return this.http.post<any>(`${this.base}/auth/mfa/recovery-codes`, { code });
  }
  disable(code: string): Observable<{ success: boolean }> {
    return this.http.post<any>(`${this.base}/auth/mfa/disable`, { code });
  }
  adminReset(userId: string, reason?: string): Observable<{ success: boolean; hadMfa: boolean }> {
    return this.http.post<any>(`${this.base}/users/${userId}/mfa/reset`, { reason });
  }
  getPolicy(): Observable<MfaPolicy> { return this.http.get<MfaPolicy>(`${this.base}/settings/mfa`); }
  setPolicy(requiredRoles: string[]): Observable<MfaPolicy> {
    return this.http.put<MfaPolicy>(`${this.base}/settings/mfa`, { requiredRoles });
  }
}

/** True for the API's "needs a fresh second factor" answer. */
export function isStepUpRequired(err: any): boolean {
  return err?.status === 401 && err?.error?.error === 'step_up_required';
}

/** Text file with the recovery codes, for download. */
export function recoveryCodesFile(codes: string[], account = ''): string {
  return [
    'Platform recovery codes' + (account ? ` for ${account}` : ''),
    `Generated ${new Date().toISOString()}`,
    'Each code can be used once instead of an authenticator code.',
    '',
    ...codes,
    '',
  ].join('\n');
}

export function downloadRecoveryCodes(codes: string[], account = ''): void {
  const blob = new Blob([recoveryCodesFile(codes, account)], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'platform-recovery-codes.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
