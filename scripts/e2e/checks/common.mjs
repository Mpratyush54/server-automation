// Shared helpers for the e2e checks. Each check script prints short pass/fail
// lines; run-checks.sh keeps the full output in the (redacted) artifact only.
import { readFileSync } from 'node:fs';

export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} is required`);
  }
  return v;
}

export const domain = () => env('E2E_DOMAIN');
export const apiUrl = () => env('PLATFORM_URL', `https://api.${domain()}`).replace(/\/+$/, '');
export const adminEmail = () => env('ADMIN_EMAIL');
export const adminPassword = () => readFileSync(env('E2E_ADMIN_PASSWORD_FILE'), 'utf8').trim();

let failures = 0;
export function ok(name) { console.log(`  ok   ${name}`); }
export function bad(name, detail = '') {
  failures += 1;
  console.log(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
}
export function expect(cond, name, detail) { (cond ? ok : bad)(name, cond ? '' : detail); return cond; }
export function finish() {
  if (failures > 0) process.exit(1);
}

/** fetch without following redirects; never throws on HTTP status. */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, setCookies: res.headers.getSetCookie?.() || [], text, json };
}

/** Minimal cookie jar: name=value pairs from Set-Cookie, sent back verbatim. */
export class CookieJar {
  constructor() { this.cookies = new Map(); }
  store(res) {
    for (const c of res.setCookies || []) {
      const pair = c.split(';', 1)[0];
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return res;
  }
  has(name) { return this.cookies.has(name) && this.cookies.get(name) !== ''; }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
}

export async function retry(fn, { attempts = 12, delayMs = 5000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw last;
}

export async function login() {
  const r = await retry(async () => {
    const res = await request(`${apiUrl()}/api/auth/login`, { method: 'POST', body: { email: adminEmail(), password: adminPassword() } });
    if (res.status >= 500) throw new Error(`login HTTP ${res.status}`);
    return res;
  }, { attempts: 6 });
  if (r.status !== 200 || !r.json?.token) throw new Error(`admin login failed: HTTP ${r.status}`);
  return r.json.token;
}

export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    bad('unexpected error', e?.message || String(e));
  }
  finish();
}
