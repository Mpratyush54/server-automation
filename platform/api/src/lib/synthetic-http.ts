import http from 'http';
import https from 'https';
import tls from 'tls';
import { GuardOptions, pinnedLookup, resolveTarget, ResolvedTarget, SsrfError } from './synthetic-ssrf';

/**
 * Outbound HTTP/TLS client for synthetic checks (#42).
 *
 * - Every request (and every redirect hop) goes through the SSRF guard and connects to
 *   the address the guard validated (pinned lookup; no second DNS query).
 * - Hard caps: redirects (<= 5), total time per request, response size (1 MiB default;
 *   the body is truncated, the request is not failed for it).
 * - Never sends platform credentials: no cookies, no Authorization unless the check
 *   configures it, a fixed User-Agent, a fresh connection per request (no agent pool),
 *   and user headers are dropped when a redirect leaves the original origin.
 * - No proxy environment variables are honoured.
 */

export const MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const USER_AGENT = 'platform-synthetics/1.0';

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  maxBodyBytes?: number;
  /** Skip TLS verification (self-signed targets). The certificate is still reported. */
  tlsInsecure?: boolean;
}

export interface HttpResponseResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  latencyMs: number;
  redirects: number;
  finalUrl: string;
  /** Validated address of the final hop. */
  address: string;
  tls: TlsInfo | null;
}

export interface TlsInfo {
  validTo: string | null;
  daysRemaining: number | null;
  authorized: boolean;
  authorizationError: string | null;
  issuer: string | null;
  subject: string | null;
}

export class SyntheticRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SyntheticRequestError';
  }
}

const DROP_ON_CROSS_ORIGIN = true;

function certInfo(socket: any, now = Date.now()): TlsInfo | null {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null;
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return null;
  const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
  const ok = validTo && !Number.isNaN(validTo.getTime());
  return {
    validTo: ok ? validTo!.toISOString() : null,
    daysRemaining: ok ? Math.floor((validTo!.getTime() - now) / 86_400_000) : null,
    authorized: socket.authorized === true,
    authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
    issuer: cert.issuer?.O || cert.issuer?.CN || null,
    subject: cert.subject?.CN || null,
  };
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

interface OneHop {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  tls: TlsInfo | null;
}

function requestOnce(target: ResolvedTarget, spec: { method: string; headers: Record<string, string>; body?: string; deadline: number; maxBodyBytes: number; tlsInsecure: boolean }): Promise<OneHop> {
  return new Promise((resolve, reject) => {
    const remaining = spec.deadline - Date.now();
    if (remaining <= 0) return reject(new SyntheticRequestError('Timed out', 'timeout'));
    const isHttps = target.url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = { ...spec.headers };
    const hostHeader = target.url.port ? `${target.hostname}:${target.url.port}` : target.hostname;
    const options: https.RequestOptions = {
      method: spec.method,
      host: target.hostname,
      port: target.port,
      path: `${target.url.pathname || '/'}${target.url.search || ''}`,
      headers: { host: hostHeader, 'user-agent': USER_AGENT, accept: '*/*', ...headers },
      lookup: pinnedLookup(target) as any,
      agent: false,
      ...(isHttps ? { servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname, rejectUnauthorized: !spec.tlsInsecure } : {}),
    };
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const info = isHttps ? certInfo(res.socket) : null;
      res.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const room = spec.maxBodyBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, Math.max(0, room)));
          size = spec.maxBodyBytes;
          truncated = true;
          finish(() => resolve({ status: res.statusCode || 0, headers: flattenHeaders(res.headers), body: Buffer.concat(chunks).toString('utf8'), truncated, tls: info }));
          res.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => finish(() => resolve({ status: res.statusCode || 0, headers: flattenHeaders(res.headers), body: Buffer.concat(chunks).toString('utf8'), truncated, tls: info })));
      res.on('error', (err) => finish(() => reject(new SyntheticRequestError(err.message, 'network'))));
    });
    const timer = setTimeout(() => {
      finish(() => reject(new SyntheticRequestError(`Timed out after ${Math.round(remaining)} ms`, 'timeout')));
      req.destroy();
    }, remaining);
    req.on('error', (err: any) => finish(() => reject(new SyntheticRequestError(err?.message || 'request failed', err?.code === 'CERT_HAS_EXPIRED' || /certificate|self.signed|SSL|TLS/i.test(String(err?.message || err?.code)) ? 'tls' : 'network'))));
    if (spec.body !== undefined && spec.body !== '') req.write(spec.body);
    req.end();
  });
}

/** Issue one HTTP request (following redirects within the caps). Throws SsrfError / SyntheticRequestError. */
export async function syntheticHttpRequest(spec: HttpRequestSpec, guard: GuardOptions = {}): Promise<HttpResponseResult> {
  const started = Date.now();
  const deadline = started + Math.max(1, spec.timeoutMs);
  const maxRedirects = Math.min(MAX_REDIRECTS, Math.max(0, spec.maxRedirects ?? MAX_REDIRECTS));
  const maxBodyBytes = Math.min(spec.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  let method = (spec.method || 'GET').toUpperCase();
  let body = spec.body;
  let headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers || {})) headers[k.toLowerCase()] = String(v);
  // The platform never forwards its own cookies / credentials; only check-defined headers go out.
  delete headers.host;

  let url = spec.url;
  const origin = new URL(spec.url).origin;
  let redirects = 0;
  for (;;) {
    const target = await resolveTarget(url, guard);
    const hop = await requestOnce(target, { method, headers, body, deadline, maxBodyBytes, tlsInsecure: !!spec.tlsInsecure });
    const location = hop.headers.location;
    if (spec.followRedirects !== false && hop.status >= 300 && hop.status < 400 && location) {
      if (redirects >= maxRedirects) throw new SyntheticRequestError(`More than ${maxRedirects} redirects`, 'redirects');
      redirects += 1;
      const next = new URL(location, target.url).toString();
      if (DROP_ON_CROSS_ORIGIN && new URL(next).origin !== origin) headers = {};
      if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        delete headers['content-type'];
        delete headers['content-length'];
      }
      url = next;
      continue;
    }
    return {
      status: hop.status,
      headers: hop.headers,
      body: hop.body,
      truncated: hop.truncated,
      latencyMs: Date.now() - started,
      redirects,
      finalUrl: url,
      address: target.address,
      tls: hop.tls,
    };
  }
}

/** TLS handshake only (SSL expiry checks). Connects to the validated address with SNI. */
export async function syntheticTlsProbe(host: string, port: number, timeoutMs: number, guard: GuardOptions = {}): Promise<TlsInfo & { latencyMs: number; address: string }> {
  const started = Date.now();
  const target = await resolveTarget(`https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/`, guard);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.address,
      port: target.port,
      servername: /^[\d.]+$|:/.test(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: false, // reported via authorized/authorizationError instead
      timeout: timeoutMs,
    });
    const timer = setTimeout(() => { socket.destroy(); reject(new SyntheticRequestError(`Timed out after ${timeoutMs} ms`, 'timeout')); }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const info = certInfo(socket);
      socket.end();
      if (!info) return reject(new SyntheticRequestError('No certificate presented', 'tls'));
      resolve({ ...info, latencyMs: Date.now() - started, address: target.address });
    });
    socket.once('error', (err: any) => { clearTimeout(timer); reject(new SyntheticRequestError(err?.message || 'TLS handshake failed', 'tls')); });
  });
}

export { SsrfError };
