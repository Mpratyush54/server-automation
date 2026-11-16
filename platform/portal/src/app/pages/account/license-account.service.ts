import { Injectable } from '@angular/core';

export const LICENSE_SERVER = 'https://license.cairnpaas.dev';
export const SALES_EMAIL = 'sales@cairnpaas.dev';

export interface AccountKey {
  id: string;
  hint?: string;
  plan?: string;
  org?: string;
  revoked?: boolean;
  expires_at?: string | null;
  max_nodes?: number;
  max_installs?: number;
}

export interface AccountInstall {
  id: string;
  key_id?: string;
  version?: string;
  profile?: string;
  node_count?: number;
  offline?: boolean;
  activated_at?: string;
  last_seen_at?: string;
  active?: boolean;
  fingerprint_prefix?: string;
}

export class LicenseApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Account API of the license server (cookie session). */
@Injectable({ providedIn: 'root' })
export class LicenseAccountService {
  base = LICENSE_SERVER;
  fetchFn: typeof fetch = (input, init) => fetch(input, init);

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, init);
    } catch {
      throw new LicenseApiError(0, 'network', 'Could not reach the account service. Check your connection and try again.');
    }
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const code = data?.error?.code || 'error';
      throw new LicenseApiError(res.status, code, data?.error?.message || `Request failed (${res.status}).`);
    }
    return data as T;
  }

  signup(email: string, password: string) { return this.request('POST', '/v1/auth/signup', { email, password }); }
  verify(token: string) { return this.request<{ verified: boolean; license_key?: string; key?: AccountKey }>('POST', '/v1/auth/verify', { token }); }
  resend(email: string) { return this.request('POST', '/v1/auth/resend', { email }); }
  signin(email: string, password: string) { return this.request('POST', '/v1/auth/signin', { email, password }); }
  signout() { return this.request('POST', '/v1/auth/signout', {}); }
  account() { return this.request<{ account: { email?: string } }>('GET', '/v1/account'); }
  deleteAccount(password: string) { return this.request('DELETE', '/v1/account', { password }); }
  keys() { return this.request<{ keys: AccountKey[] }>('GET', '/v1/account/keys'); }
  createKey() { return this.request<{ license_key: string; key: AccountKey }>('POST', '/v1/account/keys', {}); }
  rotateKey(id: string) { return this.request<{ license_key: string; key: AccountKey }>('POST', `/v1/account/keys/${encodeURIComponent(id)}/rotate`, {}); }
  revokeKey(id: string) { return this.request('POST', `/v1/account/keys/${encodeURIComponent(id)}/revoke`, {}); }
  installs() { return this.request<{ installs: AccountInstall[] }>('GET', '/v1/account/installs'); }
  deactivateInstall(id: string) { return this.request('POST', `/v1/account/installs/${encodeURIComponent(id)}/deactivate`, {}); }
  offline(keyId: string, request: string) {
    return this.request<{ install_id: string; expires_at: string; filename: string; license_file: string }>('POST', '/v1/account/offline', { key_id: keyId, request });
  }
}
