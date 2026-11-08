import { HttpHeaders } from '@angular/common/http';
import { PlatformConfig } from './platform-config';

/** Headers for every Platform SDK API call (`Authorization: Bearer <sdk token>`). */
export function platformHeaders(config: PlatformConfig): HttpHeaders {
  let headers = new HttpHeaders({ 'Content-Type': 'application/json' });
  if (config.token) {
    headers = headers.set('Authorization', `Bearer ${config.token}`);
  }
  return headers;
}

/** True when `url` targets the Platform SDK API itself (telemetry, bug reports). */
export function isPlatformSdkUrl(config: PlatformConfig, url: string): boolean {
  const base = (config.apiBase || '').replace(/\/+$/, '');
  return url.startsWith(`${base}/api/sdk/`) || (!base && url.startsWith('/api/sdk/'));
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(bearer|basic)?\s*[^\s,;"'}]+/gi, '$1[REDACTED]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]'],
  [/\b(sdk_(?:live|test)_|plat_agent_)[A-Za-z0-9._-]+/g, '$1[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]'],
  [/((?:set-)?cookie\s*[:=]\s*)[^\n]+/gi, '$1[REDACTED]'],
  [
    /(["']?\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|session(?:id)?)\b["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi,
    '$1[REDACTED]',
  ],
];

/** Strip credentials (Authorization/Bearer values, SDK tokens, JWTs, cookies, password-like fields). */
export function redactSensitive(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
