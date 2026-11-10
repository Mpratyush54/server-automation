import crypto from 'crypto';
import type { ConfigStore } from './config-store';
import { ingestTokenTtlSeconds } from './telemetry-config';

/**
 * Ingest tokens for the telemetry collector (issue #49).
 *
 * Format: `<prefix><payload>.<signature>` where
 *  - prefix is `plat_ingest_` (server SDKs: OTLP traces/logs/metrics, profiles) or
 *    `plat_ingest_web_` (browser SDKs: Faro RUM only, origin-restricted);
 *  - payload is base64url JSON `{ v, typ, pid, env, iat, exp, o? }`;
 *  - signature is base64url HMAC-SHA256 over `<prefix><payload>` with a key derived
 *    from the ingest signing key.
 *
 * Tokens are stateless (no DB/Redis lookup to verify), project + environment scoped and
 * short-lived. They are never accepted by API authentication (expressAuthenticate /
 * sdkTokenAuth only take JWTs, plat_agent_ and sdk_ credentials).
 */

export const INGEST_TOKEN_PREFIX = 'plat_ingest_';
export const INGEST_WEB_TOKEN_PREFIX = 'plat_ingest_web_';
export const INGEST_SIGNING_KEY_NAME = 'TELEMETRY_INGEST_SIGNING_KEY';
const MAX_TOKEN_LENGTH = 4096;
const MAX_ORIGINS = 20;
/** Accept tokens whose iat is at most this far in the future (clock skew between replicas). */
const CLOCK_SKEW_S = 300;

export type IngestTokenType = 'server' | 'web';

export interface IngestClaims {
  typ: IngestTokenType;
  projectId: string;
  environment: string;
  iat: number;
  exp: number;
  /** Allowed browser origins (web tokens only). */
  origins: string[];
}

export class TelemetryKeyUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Telemetry ingest signing key unavailable') {
    super(message);
    this.name = 'TelemetryKeyUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Signing key
// ---------------------------------------------------------------------------

let keys: Buffer[] | null = null; // [current, previous?] — derived MAC keys
let keySource: string | null = null;
let lastLoadFailure = 0;
let loading: Promise<Buffer[]> | null = null;
let storeOverride: ConfigStore | null | undefined;
const RELOAD_BACKOFF_MS = 30_000;

function derive(raw: string): Buffer {
  return crypto.createHmac('sha256', raw).update('plat-ingest-token-v1').digest();
}

function validRaw(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length >= 32;
}

async function defaultStore(): Promise<ConfigStore | null> {
  if (storeOverride !== undefined) return storeOverride;
  // Tests never touch host files unless a store is injected.
  if (process.env.NODE_ENV === 'test') return null;
  const { useKubeConfigStore, credentialsStore, platformEnvStore } = await import('./config-store');
  // Cluster: platform-credentials (envFrom'd into the API, backed up by platformctl, get/update
  // already granted to the API). Dev: the platform dotenv file.
  return useKubeConfigStore() ? credentialsStore() : platformEnvStore();
}

async function loadKeys(): Promise<Buffer[]> {
  const previous = process.env.TELEMETRY_INGEST_SIGNING_KEY_PREVIOUS;
  const withPrev = (cur: string) => [derive(cur.trim()), ...(validRaw(previous) ? [derive(previous.trim())] : [])];

  const fromEnv = process.env[INGEST_SIGNING_KEY_NAME];
  if (validRaw(fromEnv)) {
    keySource = 'env';
    return withPrev(fromEnv);
  }
  const store = await defaultStore();
  if (!store) {
    keySource = 'memory';
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[telemetry] no config store: ingest tokens are signed with a per-process key');
    }
    return withPrev(crypto.randomBytes(32).toString('hex'));
  }
  const candidate = crypto.randomBytes(32).toString('hex');
  let stored: string | undefined;
  if (store.setIfAbsent) {
    stored = await store.setIfAbsent(INGEST_SIGNING_KEY_NAME, candidate);
  } else {
    stored = (await store.read())[INGEST_SIGNING_KEY_NAME];
    if (!validRaw(stored)) {
      await store.patch({ [INGEST_SIGNING_KEY_NAME]: candidate });
      stored = (await store.read())[INGEST_SIGNING_KEY_NAME];
    }
  }
  if (!validRaw(stored)) throw new Error(`${store.description} has no usable ${INGEST_SIGNING_KEY_NAME}`);
  keySource = stored === candidate ? `generated in ${store.description}` : store.description;
  return withPrev(stored);
}

/**
 * Resolve the signing key (boot or first use). In the cluster the key is created once in
 * platform-credentials (compare-and-swap, so every replica ends up with the same key).
 * Never throws; on failure the next use retries after a short backoff.
 */
export async function initIngestSigningKey(): Promise<{ ok: boolean; source: string | null; error?: string }> {
  try {
    await getIngestKeys();
    return { ok: true, source: keySource };
  } catch (err: any) {
    return { ok: false, source: null, error: err?.message || String(err) };
  }
}

async function getIngestKeys(): Promise<Buffer[]> {
  if (keys) return keys;
  if (Date.now() - lastLoadFailure < RELOAD_BACKOFF_MS) throw new TelemetryKeyUnavailableError();
  if (!loading) {
    loading = loadKeys().then(
      (k) => { keys = k; loading = null; return k; },
      (err) => {
        loading = null;
        lastLoadFailure = Date.now();
        console.warn(`[telemetry] ingest signing key unavailable: ${err?.message || err}`);
        throw new TelemetryKeyUnavailableError();
      },
    );
  }
  return loading;
}

/** Test hooks. */
export function setIngestSigningKeyForTests(raw: string | null, previous?: string): void {
  keys = raw ? [derive(raw), ...(previous ? [derive(previous)] : [])] : null;
  keySource = raw ? 'test' : null;
  lastLoadFailure = 0;
  loading = null;
}
export function setIngestKeyStoreForTests(store: ConfigStore | null | undefined): void {
  storeOverride = store;
  keys = null;
  keySource = null;
  lastLoadFailure = 0;
  loading = null;
}

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/**
 * Normalise an origin (`https://app.example.com[:port]`, or `https://*.example.com` for any
 * subdomain). Bare hostnames become https origins. Returns null for anything else.
 */
export function normalizeOrigin(value: string): string | null {
  let v = String(value || '').trim().toLowerCase().replace(/\/+$/, '');
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(v)) v = `https://${v}`;
  const m = /^(https?):\/\/(\*\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)(:\d{1,5})?$/.exec(v);
  if (!m) return null;
  return `${m[1]}://${m[2] || ''}${m[3]}${m[4] || ''}`;
}

/** Does the request Origin match one of the allowed (normalised) origins? */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  const o = normalizeOrigin(origin);
  if (!o || o.includes('*')) return false;
  for (const a of allowed) {
    if (a === o) return true;
    const w = /^(https?):\/\/\*\.(.+)$/.exec(a);
    if (w) {
      const [scheme, rest] = [w[1], w[2]];
      if (o.startsWith(`${scheme}://`) && o.slice(scheme.length + 3).endsWith(`.${rest}`)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Issue / verify
// ---------------------------------------------------------------------------

const UUIDISH = /^[A-Za-z0-9-]{1,64}$/;
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(key: Buffer, signed: string): string {
  return crypto.createHmac('sha256', key).update(signed).digest('base64url');
}

export interface IssueOptions {
  projectId: string;
  environment: string;
  type: IngestTokenType;
  origins?: string[];
  ttlSeconds?: number;
  now?: number; // ms
}

/**
 * Issue an ingest token. `iat` is aligned to a window (≤ 1 h) so repeated config fetches
 * return the same token — friendlier to the ingress auth cache — while the remaining
 * lifetime never drops below ttl − window.
 */
export async function issueIngestToken(opts: IssueOptions): Promise<{ token: string; expiresAt: Date }> {
  if (!UUIDISH.test(opts.projectId)) throw new Error('invalid project id');
  if (!ENV_NAME.test(opts.environment)) throw new Error('invalid environment name');
  const [key] = await getIngestKeys();
  const ttl = Math.max(60, Math.floor(opts.ttlSeconds ?? ingestTokenTtlSeconds()));
  const window = Math.max(1, Math.min(3600, Math.floor(ttl / 4)));
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  const iat = nowS - (nowS % window);
  const exp = iat + ttl;
  const payload: Record<string, unknown> = { v: 1, typ: opts.type, pid: opts.projectId, env: opts.environment, iat, exp };
  if (opts.type === 'web') {
    const origins = [...new Set((opts.origins || []).map(normalizeOrigin).filter((o): o is string => !!o))].sort();
    payload.o = origins.slice(0, MAX_ORIGINS);
  }
  const prefix = opts.type === 'web' ? INGEST_WEB_TOKEN_PREFIX : INGEST_TOKEN_PREFIX;
  const body = b64url(JSON.stringify(payload));
  return { token: `${prefix}${body}.${sign(key, prefix + body)}`, expiresAt: new Date(exp * 1000) };
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid';
export type VerifyResult = { ok: true; claims: IngestClaims } | { ok: false; reason: VerifyFailure };

export function looksLikeIngestToken(token: string): boolean {
  return token.startsWith(INGEST_TOKEN_PREFIX);
}

/** Verify signature (constant time) and lifetime. Scope/origin checks are the caller's. */
export async function verifyIngestToken(token: string, nowMs: number = Date.now()): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'malformed' };
  let typ: IngestTokenType;
  let prefix: string;
  if (token.startsWith(INGEST_WEB_TOKEN_PREFIX)) {
    typ = 'web';
    prefix = INGEST_WEB_TOKEN_PREFIX;
  } else if (token.startsWith(INGEST_TOKEN_PREFIX)) {
    typ = 'server';
    prefix = INGEST_TOKEN_PREFIX;
  } else {
    return { ok: false, reason: 'malformed' };
  }
  const rest = token.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot <= 0 || dot !== rest.lastIndexOf('.')) return { ok: false, reason: 'malformed' };
  const body = rest.slice(0, dot);
  const sig = rest.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return { ok: false, reason: 'malformed' };

  const keyList = await getIngestKeys();
  const given = Buffer.from(sig, 'base64url');
  let valid = false;
  for (const key of keyList) {
    const expected = Buffer.from(sign(key, prefix + body), 'base64url');
    // Both are 32 bytes (sig format checked above); evaluate every key, no early exit.
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) valid = true;
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  let p: any;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!p || p.v !== 1 || p.typ !== typ || typeof p.pid !== 'string' || !UUIDISH.test(p.pid)
    || typeof p.env !== 'string' || !ENV_NAME.test(p.env)
    || !Number.isInteger(p.iat) || !Number.isInteger(p.exp)) {
    return { ok: false, reason: 'malformed' };
  }
  const nowS = Math.floor(nowMs / 1000);
  if (p.exp <= nowS) return { ok: false, reason: 'expired' };
  if (p.iat > nowS + CLOCK_SKEW_S) return { ok: false, reason: 'not_yet_valid' };
  const origins: string[] = typ === 'web' && Array.isArray(p.o) ? p.o.filter((o: unknown) => typeof o === 'string') : [];
  return { ok: true, claims: { typ, projectId: p.pid, environment: p.env, iat: p.iat, exp: p.exp, origins } };
}

/** Collector paths and the token type allowed on each (ingress-nginx sends X-Original-URL). */
export function scopeForPath(path: string): 'otlp' | 'profiles' | 'rum' | null {
  const p = path.split('?')[0].replace(/\/+$/, '') || '/';
  if (/^\/v1\/(traces|logs|metrics)$/.test(p)) return 'otlp';
  if (p === '/pyroscope' || p.startsWith('/pyroscope/')) return 'profiles';
  if (p === '/collect' || p.startsWith('/collect/')) return 'rum';
  return null;
}

export function tokenTypeAllowedFor(typ: IngestTokenType, scope: ReturnType<typeof scopeForPath>): boolean {
  if (scope === null) return false;
  return typ === 'web' ? scope === 'rum' : scope === 'otlp' || scope === 'profiles';
}
