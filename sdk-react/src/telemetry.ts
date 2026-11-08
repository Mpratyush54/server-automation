import axios, { AxiosInstance } from 'axios';
import type { PlatformConfig } from './context';

/** Headers for every Platform SDK API call. */
export function platformHeaders(config: PlatformConfig): Record<string, string> {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
}

/** Dedicated client for SDK telemetry; has no interceptors so it can never meter itself. */
export function createTelemetryClient(config: PlatformConfig): AxiosInstance {
  return axios.create({ baseURL: config.apiBase, headers: platformHeaders(config) });
}

function isSdkRoute(url: string | undefined): boolean {
  return !!url && /(^|\/)api\/sdk\//.test(url);
}

interface MetricPayload {
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
}

/**
 * Meter every request made through `api`, posting metrics with `telemetry`
 * (a different instance). Returns a function that removes the interceptors.
 */
export function attachMetrics(
  api: AxiosInstance,
  telemetry: AxiosInstance,
  config: PlatformConfig,
): () => void {
  const send = (payload: MetricPayload) => {
    telemetry
      .post('/api/sdk/api-metrics', {
        projectId: config.projectId,
        environment: config.environment || 'production',
        ...payload,
      })
      .catch(() => {});
  };

  const reqId = api.interceptors.request.use((cfg) => {
    (cfg as any).__startTime = Date.now();
    return cfg;
  });

  const resId = api.interceptors.response.use(
    (res) => {
      if (!isSdkRoute(res.config.url)) {
        send({
          route: redactSensitive(res.config.url || ''),
          method: (res.config.method || 'get').toUpperCase(),
          statusCode: res.status,
          durationMs: Date.now() - ((res.config as any).__startTime || Date.now()),
        });
      }
      return res;
    },
    (err) => {
      if (err.config && !isSdkRoute(err.config.url)) {
        send({
          route: redactSensitive(err.config.url || ''),
          method: (err.config.method || 'get').toUpperCase(),
          statusCode: err.response?.status || 0,
          durationMs: Date.now() - ((err.config as any).__startTime || Date.now()),
        });
      }
      return Promise.reject(err);
    },
  );

  return () => {
    api.interceptors.request.eject(reqId);
    api.interceptors.response.eject(resId);
  };
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
 * Blank out sensitive form fields in a (cloned) document before it is rendered
 * to a screenshot: password inputs, credit-card/one-time-code autocomplete
 * fields, and anything marked `data-platform-mask`.
 */
export function maskSensitiveInputs(doc: Pick<Document, 'querySelectorAll'>): number {
  const selector = [
    'input[type="password"]',
    'input[autocomplete^="cc-"]',
    'input[autocomplete="one-time-code"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="new-password"]',
    '[data-platform-mask]',
  ].join(',');
  const nodes = doc.querySelectorAll(selector);
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
