import { Injectable } from '@angular/core';

export const LICENSE_SERVER = 'https://license.cairnpaas.dev';
export const SALES_EMAIL = 'sales@cairnpaas.dev';
export const PRIVACY_EMAIL = 'privacy@cairnpaas.dev';

export interface AccountInfo {
  id?: string;
  email?: string;
  email_verified?: boolean;
  email_verified_at?: string | null;
  created_at?: string;
}

export interface AccountKey {
  id: string;
  hint?: string;
  plan?: string;
  org?: string;
  revoked?: boolean;
  expires_at?: string | null;
  max_nodes?: number;
  max_installs?: number;
  checkin_required?: boolean;
  created_at?: string;
  revoked_at?: string;
  revoke_reason?: string;
}

export interface AccountInstall {
  id: string;
  version?: string;
  profile?: string;
  node_count?: number;
  offline?: boolean;
  activated_at?: string;
  last_seen_at?: string;
  active?: boolean;
  key_id?: string;
  deactivated_at?: string;
  /** First characters of the stored machine fingerprint, to tell installs apart. */
  fingerprint_prefix?: string;
}

/** The diagnostics report body as the install sent it (after redaction). */
export interface DiagnosticsPayload {
  schema?: number;
  kind?: string;
  operation?: string;
  generated_at?: string;
  platform?: { version?: string; profile?: string; node_count?: number; arch?: string; os_release?: string; k8s_version?: string };
  uptime_seconds?: number;
  steps?: { step: string; seconds?: number; status?: string }[] | null;
  failures?: { step: string; error?: string }[] | null;
  components?: { name: string; status?: string }[] | null;
  counts?: { projects?: number; environments?: number; deployments?: number; users?: number } | null;
  [extra: string]: unknown;
}

export interface DiagnosticsReport {
  id: string;
  install_id?: string;
  received_at: string;
  kind: string;
  version?: string;
  profile?: string;
  failed?: boolean;
  payload: DiagnosticsPayload | null;
}

export interface InstallReports {
  install_id: string;
  reports: DiagnosticsReport[];
  limit?: number;
  truncated?: boolean;
  retention_days?: number;
}

export interface AccountExport {
  filename: string;
  content: string;
}

export interface QuoteRequest {
  company: string;
  name: string;
  email: string;
  servers: number;
  message: string;
  /** Honeypot: always empty for people. */
  website: string;
}

export class LicenseApiError extends Error {
  constructor(public status: number, public code: string, message: string, public fields: Record<string, string> = {}) { super(message); }
}

/** Account API of the license server (cookie session). */
@Injectable({ providedIn: 'root' })
export class LicenseAccountService {
  base = LICENSE_SERVER;
  fetchFn: typeof fetch = (input, init) => fetch(input, init);

  async request<T = any>(method: string, path: string, body?: unknown, credentials: RequestCredentials = 'include'): Promise<T> {
    const { text } = await this.send(method, path, body, credentials);
    try { return (text ? JSON.parse(text) : null) as T; } catch { return null as T; }
  }

  /** Sends a request and returns the raw body; throws LicenseApiError on failure. */
  private async send(method: string, path: string, body?: unknown, credentials: RequestCredentials = 'include'): Promise<{ res: Response; text: string }> {
    const init: RequestInit = { method, credentials, headers: { Accept: 'application/json' } };
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
    if (!res.ok) {
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      const code = data?.error?.code || 'error';
      const fields = data?.error?.fields && typeof data.error.fields === 'object' ? data.error.fields : {};
      throw new LicenseApiError(res.status, code, data?.error?.message || `Request failed (${res.status}).`, fields);
    }
    return { res, text };
  }

  /** Public sales form; sends no cookies. */
  requestQuote(q: QuoteRequest) { return this.request('POST', '/v1/quotes/request', q, 'omit'); }
  signup(email: string, password: string) { return this.request('POST', '/v1/auth/signup', { email, password }); }
  verify(token: string) { return this.request<{ verified: boolean; license_key?: string; key?: AccountKey }>('POST', '/v1/auth/verify', { token }); }
  resend(email: string) { return this.request('POST', '/v1/auth/resend', { email }); }
  signin(email: string, password: string) { return this.request('POST', '/v1/auth/signin', { email, password }); }
  signout() { return this.request('POST', '/v1/auth/signout', {}); }
  account() { return this.request<{ account: AccountInfo }>('GET', '/v1/account'); }
  deleteAccount(password: string) { return this.request('DELETE', '/v1/account', { password }); }
  keys() { return this.request<{ keys: AccountKey[] }>('GET', '/v1/account/keys'); }
  createKey() { return this.request<{ license_key: string; key: AccountKey }>('POST', '/v1/account/keys', {}); }
  rotateKey(id: string) { return this.request<{ license_key: string; key: AccountKey }>('POST', `/v1/account/keys/${encodeURIComponent(id)}/rotate`, {}); }
  revokeKey(id: string) { return this.request('POST', `/v1/account/keys/${encodeURIComponent(id)}/revoke`, {}); }
  installs() { return this.request<{ installs: AccountInstall[] }>('GET', '/v1/account/installs'); }
  /** Diagnostics reports stored for one of your installs, newest first. */
  installReports(id: string, limit?: number) {
    const q = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
    return this.request<InstallReports>('GET', `/v1/account/installs/${encodeURIComponent(id)}/reports${q}`);
  }
  /** Everything held for the account, as one JSON document to save. */
  async exportData(): Promise<AccountExport> {
    const { res, text } = await this.send('GET', '/v1/account/export');
    return { filename: exportFilename(res.headers.get('Content-Disposition')), content: text };
  }
  deactivateInstall(id: string) { return this.request('POST', `/v1/account/installs/${encodeURIComponent(id)}/deactivate`, {}); }
  offline(keyId: string, request: string) {
    return this.request<{ install_id: string; expires_at: string; filename: string; license_file: string }>('POST', '/v1/account/offline', { key_id: keyId, request });
  }
}

/** Reads the file name from a Content-Disposition header, with a safe fallback. */
export function exportFilename(header: string | null): string {
  const m = /filename="?([^";]+)"?/i.exec(header || '');
  const name = m ? m[1].trim() : '';
  return /^[\w.-]+\.json$/.test(name) ? name : 'cairn-account-data.json';
}
