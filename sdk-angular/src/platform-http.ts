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

/**
 * Elements that hold secrets or payment data (password / credit-card / one-time-code
 * fields and anything marked `data-platform-mask`). Used by `maskSensitiveInputs`
 * and by RUM click tracking.
 */
export const SENSITIVE_INPUT_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete^="cc-"]',
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  '[data-platform-mask]',
].join(',');

/**
 * Blank out sensitive form fields in a (cloned) document, e.g. before it is
 * rendered to a screenshot (same behaviour as sdk-react's `maskSensitiveInputs`).
 */
export function maskSensitiveInputs(doc: Pick<Document, 'querySelectorAll'>): number {
  const nodes = doc.querySelectorAll(SENSITIVE_INPUT_SELECTOR);
  nodes.forEach((node: any) => {
    if ('value' in node) {
      node.value = '';
      node.setAttribute?.('value', '');
    } else {
      node.textContent = '••••';
    }
  });
  return nodes.length;
}
