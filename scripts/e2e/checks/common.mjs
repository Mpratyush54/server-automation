// Shared helpers for the e2e checks. Each check script prints short pass/fail
// lines; run-checks.sh keeps the full output in the (redacted) artifact only.
import { createHmac } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

// --- MFA (#24, #114) ------------------------------------------------------------
// Admin and devops must use a second factor. The suite enrols the admin once
// (mfa-flow, or the first adminSession() call) and keeps the TOTP secret and
// recovery codes in $E2E_WORK/admin-mfa.json (0600; never printed; E2E_WORK is
// never uploaded, and collect.sh passes the file to redact.py --mfa-state).

export const TOTP_STEP_MS = 30000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 decode (case-insensitive; padding and spaces ignored). */
export function base32Decode(s) {
  let bits = '';
  for (const c of String(s).replace(/[\s=]/g, '').toUpperCase()) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error('invalid base32 secret');
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** RFC 4226 HOTP; `key` is the raw key (Buffer). */
export function hotp(key, counter, { digits = 6, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

/** RFC 6238 TOTP; `secret` is base32 (as enrolment returns it) or a raw key Buffer. */
export function totp(secret, { time = Date.now(), stepSeconds = 30, digits = 6, algorithm = 'sha1' } = {}) {
  const key = Buffer.isBuffer(secret) ? secret : base32Decode(secret);
  return hotp(key, Math.floor(time / 1000 / stepSeconds), { digits, algorithm });
}

export const totpStep = (time = Date.now()) => Math.floor(time / TOTP_STEP_MS);

/** Payload of a JWT, unverified (null when the value is not a JWT). */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : null;
  } catch { return null; }
}

export function mfaStateFile() {
  if (process.env.E2E_MFA_STATE_FILE) return process.env.E2E_MFA_STATE_FILE;
  return process.env.E2E_WORK ? path.join(process.env.E2E_WORK, 'admin-mfa.json') : '';
}

export function readMfaState(file = mfaStateFile()) {
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Atomic write with mode 0600. */
export function writeMfaState(state, file = mfaStateFile()) {
  if (!file) throw new Error('no MFA state file (set E2E_WORK or E2E_MFA_STATE_FILE)');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const progress = (m) => console.log(`  ..   ${m}`);

/**
 * A TOTP code for a step after `state.lastStep`. The API accepts each step once per
 * user (replay protection), so when the current step was already used this waits for
 * the next one. Returns { code, step }; record `step` in the state once it was accepted.
 */
export async function freshTotp(state, { now = Date.now, sleep = realSleep, log = progress } = {}) {
  const last = Number(state.lastStep) || 0;
  if (totpStep(now()) <= last) {
    const waitMs = (last + 1) * TOTP_STEP_MS - now() + 1000;
    log(`waiting ${Math.ceil(waitMs / 1000)} s for the next TOTP step (codes are single use)`);
    await sleep(waitMs);
  }
  const t = now();
  return { code: totp(state.secret, { time: t }), step: totpStep(t) };
}

/**
 * Full admin session through the second factor:
 *  - login returns { mfa_required, challengeToken }: POST /api/auth/mfa/challenge with a
 *    fresh code from the stored secret;
 *  - login returns an enrolment-only session: enrol (/api/auth/mfa/enroll + /verify) and
 *    store the secret and recovery codes;
 *  - otherwise (MFA neither required nor enrolled) the password session is returned.
 * Returns { token, kind: 'challenge' | 'enrolled' | 'password' }. Never logs secrets or codes.
 */
export async function adminSession(opts = {}) {
  const o = {
    api: (opts.api ?? apiUrl()).replace(/\/+$/, ''),
    email: opts.email ?? adminEmail(),
    password: opts.password ?? adminPassword(),
    stateFile: opts.stateFile !== undefined ? opts.stateFile : mfaStateFile(),
    allowEnroll: opts.allowEnroll ?? true,
    now: opts.now ?? Date.now,
    sleep: opts.sleep ?? realSleep,
    log: opts.log ?? progress,
  };
  const post = (p, body, token) => request(`${o.api}${p}`, { method: 'POST', body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const first = await retry(async () => {
    const res = await post('/api/auth/login', { email: o.email, password: o.password });
    if (res.status >= 500) throw new Error(`login HTTP ${res.status}`);
    return res;
  }, { attempts: opts.loginAttempts ?? 6, delayMs: opts.retryDelayMs ?? 5000 });
  if (first.status !== 200) throw new Error(`admin login failed: HTTP ${first.status}`);
  const j = first.json || {};

  if (j.mfa_required) {
    const state = readMfaState(o.stateFile);
    if (!state?.secret) throw new Error('admin has MFA enabled but no stored TOTP secret (run the mfa-flow check first)');
    for (let attempt = 0; attempt < 2; attempt++) {
      const { code, step } = await freshTotp(state, o);
      const r = await post('/api/auth/mfa/challenge', { challengeToken: j.challengeToken, code });
      if (r.status === 200 && r.json?.token) {
        state.lastStep = step;
        writeMfaState(state, o.stateFile);
        return { token: r.json.token, kind: 'challenge' };
      }
      if (r.status !== 401 || r.json?.error !== 'invalid_code') {
        throw new Error(`MFA challenge failed: HTTP ${r.status}${r.json?.error ? ` ${r.json.error}` : ''}`);
      }
      // The step may have been used outside this process: try the next one, once.
      state.lastStep = Math.max(Number(state.lastStep) || 0, step);
      writeMfaState(state, o.stateFile);
    }
    throw new Error('MFA challenge rejected two fresh TOTP codes (clock skew or stale stored secret?)');
  }

  if (!j.token) throw new Error('admin login returned no session');
  const enrolOnly = j.mfaEnrollmentRequired === true || decodeJwt(j.token)?.mfa_enroll === true;
  if (!enrolOnly) return { token: j.token, kind: 'password' };
  if (!o.allowEnroll || !o.stateFile) throw new Error('admin must enrol in MFA but no MFA state file is configured (set E2E_WORK)');

  const e = await post('/api/auth/mfa/enroll', undefined, j.token);
  if (e.status !== 200 || !e.json?.secret) throw new Error(`MFA enrolment failed: HTTP ${e.status}`);
  // Stored before verification so the secret cannot be lost between the two calls.
  const state = { secret: e.json.secret, recoveryCodes: [], lastStep: 0, pending: true };
  writeMfaState(state, o.stateFile);
  const { code, step } = await freshTotp(state, o);
  const v = await post('/api/auth/mfa/verify', { code }, j.token);
  if (v.status !== 200 || !v.json?.token) throw new Error(`MFA enrolment verification failed: HTTP ${v.status}${v.json?.error ? ` ${v.json.error}` : ''}`);
  delete state.pending;
  state.recoveryCodes = Array.isArray(v.json.recoveryCodes) ? v.json.recoveryCodes : [];
  state.lastStep = step;
  state.enrolledAt = new Date(o.now()).toISOString();
  writeMfaState(state, o.stateFile);
  return { token: v.json.token, kind: 'enrolled' };
}

/** Admin session token, through the second factor (see adminSession). */
export async function login() {
  return (await adminSession()).token;
}

export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    bad('unexpected error', e?.message || String(e));
  }
  finish();
}
