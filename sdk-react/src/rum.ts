/**
 * Frontend RUM (real user monitoring) for the Platform browser SDKs.
 *
 * This module is the always-bundled part: types, privacy helpers and the
 * decision whether RUM runs at all. It never imports Grafana Faro statically.
 * Faro (web vitals, errors, resources, session/view) is loaded with a dynamic
 * `import('./rum-faro')` only when RUM is configured, enabled, allowed by
 * doNotTrack and sampled in, so apps that do not opt in ship no Faro code.
 *
 * NOTE: this file is shared verbatim between sdk-react and sdk-angular; keep
 * the copies identical (framework specifics live in `rum-deps.ts`).
 */
import { redactSensitive } from './rum-deps';
import type { PlatformReplayOptions } from './rum-replay';
import type { ClientSpan } from './rum-propagation';

/** The `telemetry` block of `GET /api/sdk/config` (only the fields the browser needs). */
export interface PlatformTelemetryConfig {
  enabled?: boolean;
  /** Faro receiver, e.g. `https://otel.<DOMAIN>/collect`. */
  faroEndpoint?: string | null;
  errorsEndpoint?: string | null;
  /** Public, project/env scoped browser ingest token (`plat_ingest_web_...`). */
  browserToken?: string | null;
  samplingRatio?: number;
  resource?: Record<string, string>;
  /** Session replay API base (`.../api/sdk/replay`); null when replay ingest is off (#40). */
  replayEndpoint?: string | null;
}

/** A Faro transport item as seen by `beforeSend` (kept structural to avoid a Faro type import). */
export interface RumTransportItem {
  type: string;
  payload: any;
  meta: any;
}

export interface PlatformRumOptions {
  /**
   * The telemetry block for this frontend (from `GET /api/sdk/config`, delivered by your
   * backend or injected at build/deploy time). The browser never calls `/api/sdk/config`
   * itself. When absent (and no `telemetryUrl`), RUM does nothing.
   */
  telemetry?: PlatformTelemetryConfig | null;
  /**
   * URL that returns the telemetry block (either the block itself or `{ telemetry: {...} }`),
   * fetched once without credentials. Used only when `telemetry` is not given.
   */
  telemetryUrl?: string;
  /**
   * Origins (or URL prefixes / RegExps) that receive a W3C `traceparent` header on
   * fetch/XHR. Default: the page's own origin only. Pass `[]` to disable propagation.
   */
  propagateTo?: Array<string | RegExp>;
  /** Session sampling ratio 0..1. Overrides `telemetry.samplingRatio`. */
  samplingRatio?: number;
  /** Do nothing when the browser sends Do-Not-Track / Global Privacy Control. Default true. */
  respectDoNotTrack?: boolean;
  /** Include (redacted, truncated) element text in click actions. Default false. */
  captureActionText?: boolean;
  /** Keep query-string values in captured URLs. Default false (values become `[REDACTED]`). */
  captureQueryValues?: boolean;
  /** Report resource timings for every resource, not only fetch/XHR. Default true. */
  trackResources?: boolean;
  appName?: string;
  appVersion?: string;
  environment?: string;
  /** Extra filter/scrubber run after the built-in redaction; return null to drop the item. */
  beforeSend?: (item: RumTransportItem) => RumTransportItem | null;
  /**
   * Privacy-first session replay (rrweb). Off when omitted. Loaded lazily; rrweb is
   * downloaded only for sampled sessions after consent. See `PlatformReplayOptions`.
   */
  replay?: PlatformReplayOptions | false;
}

export type RumSkipReason =
  | 'not-configured'
  | 'no-browser'
  | 'telemetry-disabled'
  | 'do-not-track'
  | 'not-sampled';

export interface RumPlan {
  faroEndpoint: string;
  errorsEndpoint?: string | null;
  browserToken: string;
  samplingRatio: number;
  resource: Record<string, string>;
  propagateTo: Array<string | RegExp>;
  options: PlatformRumOptions;
  appName: string;
  environment?: string;
}

/** Handle for a running RUM session. */
export interface RumHandle {
  setView(name: string): void;
  getSessionId(): string | undefined;
  getViewId(): string;
  pushEvent(name: string, attributes?: Record<string, string>): void;
  /** Report an error the framework caught (ErrorBoundary / Angular ErrorHandler). */
  pushError(error: unknown, context?: Record<string, string>): void;
  stop(): void;
}

// ---------------------------------------------------------------- privacy helpers

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** `redactSensitive` plus e-mail addresses (no PII in RUM payloads by default). */
export function scrubText(text: string): string {
  return redactSensitive(text).replace(EMAIL, '[EMAIL]');
}

/**
 * Make a URL safe to record: drop userinfo, redact query values (unless
 * `keepQueryValues`) and run the text redaction over path and fragment.
 */
export function sanitizeUrl(url: string, keepQueryValues = false): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return scrubText(url);
  }
  parsed.username = '';
  parsed.password = '';
  if (!keepQueryValues) {
    const keys: string[] = [];
    parsed.searchParams.forEach((_v, k) => keys.push(k));
    if (keys.length) {
      parsed.search = '?' + keys.map((k) => `${encodeURIComponent(k)}=[REDACTED]`).join('&');
    }
  }
  const out = parsed.toString().replace(/%5BREDACTED%5D/g, '[REDACTED]');
  return scrubText(out);
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

function scrubValue(value: unknown, keepQueryValues: boolean, depth: number): unknown {
  if (typeof value === 'string') {
    return ABSOLUTE_URL.test(value) ? sanitizeUrl(value, keepQueryValues) : scrubText(value);
  }
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, keepQueryValues, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubValue(v, keepQueryValues, depth + 1);
  }
  return out;
}

/**
 * Redact every string in a Faro transport item (payload and meta): credentials,
 * tokens, JWTs, cookies, password-like fields, e-mail addresses and URL query
 * values. Applied to every RUM item before it leaves the browser.
 */
export function scrubTransportItem<T extends RumTransportItem>(item: T, keepQueryValues = false): T {
  const meta = scrubValue(item.meta, keepQueryValues, 0) as any;
  if (meta && meta.user) {
    // Never ship direct identifiers that a host app might have set on the Faro user meta.
    delete meta.user.email;
    delete meta.user.username;
    delete meta.user.fullName;
  }
  return { ...item, payload: scrubValue(item.payload, keepQueryValues, 0), meta };
}

const DYNAMIC_SEGMENT = [
  /^\d+$/, // numeric ids
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
  /^[0-9a-f]{16,}$/i, // hex ids / hashes
  /^[A-Za-z0-9_-]{24,}$/, // opaque tokens / object ids
];

/**
 * Turn a concrete path into a low-cardinality view name: `/users/42/orders?x=1`
 * becomes `/users/:id/orders`. E-mail-like segments become `:email`.
 */
export function normalizeRouteName(path: string): string {
  const clean = (path || '/').split(/[?#]/)[0] || '/';
  const segments = clean.split('/').map((seg) => {
    if (!seg) return seg;
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      /* keep raw */
    }
    if (decoded.includes('@')) return ':email';
    return DYNAMIC_SEGMENT.some((re) => re.test(decoded)) ? ':id' : seg;
  });
  return segments.join('/') || '/';
}

// ---------------------------------------------------------------- decisions

/** True when the browser asks not to be tracked (DNT or Global Privacy Control). */
export function isDoNotTrack(nav: any, win?: any): boolean {
  const yes = (v: unknown) => v === '1' || v === 'yes' || v === 1 || v === true;
  return !!(
    (nav && (yes(nav.doNotTrack) || yes(nav.msDoNotTrack) || nav.globalPrivacyControl === true)) ||
    (win && yes(win.doNotTrack))
  );
}

const SAMPLE_KEY = 'platform.rum.sampled';

/** Session-sticky sampling decision (stored in sessionStorage when available). */
export function decideSampled(
  ratio: number,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
  random: () => number = Math.random,
): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  try {
    const prev = storage?.getItem(SAMPLE_KEY);
    if (prev === '1' || prev === '0') return prev === '1';
  } catch {
    /* storage blocked */
  }
  const sampled = random() < ratio;
  try {
    storage?.setItem(SAMPLE_KEY, sampled ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  return sampled;
}

/**
 * Whether `url` (absolute or relative to `pageOrigin`) may receive a `traceparent`
 * header. With no `propagateTo` only same-origin requests qualify. String entries
 * are absolute URLs: the request must have the same origin and start with the
 * entry's path. RegExps are tested against the absolute URL.
 */
export function shouldPropagate(
  url: string,
  propagateTo: Array<string | RegExp> | undefined,
  pageOrigin: string | undefined,
): boolean {
  let target: URL;
  try {
    target = new URL(url, pageOrigin);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  const list = propagateTo ?? (pageOrigin ? [pageOrigin] : []);
  return list.some((entry) => {
    if (entry instanceof RegExp) {
      entry.lastIndex = 0;
      return entry.test(target.href);
    }
    let allowed: URL;
    try {
      allowed = new URL(entry);
    } catch {
      return false;
    }
    if (allowed.origin !== target.origin) return false;
    const base = allowed.pathname.replace(/\/+$/, '');
    return !base || target.pathname === base || target.pathname.startsWith(base + '/');
  });
}

export interface RumEnvironment {
  win?: any;
  nav?: any;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  random?: () => number;
}

function browserEnv(): RumEnvironment {
  const win = typeof window !== 'undefined' ? window : undefined;
  let storage: Storage | null = null;
  try {
    storage = win ? win.sessionStorage : null;
  } catch {
    storage = null;
  }
  return { win, nav: typeof navigator !== 'undefined' ? navigator : undefined, storage };
}

/** Decide whether RUM runs for this page view, without loading anything. */
export function planRum(
  options: PlatformRumOptions | false | null | undefined,
  telemetry: PlatformTelemetryConfig | null | undefined,
  defaults: { appName?: string; environment?: string } = {},
  env: RumEnvironment = browserEnv(),
): { plan: RumPlan } | { skip: RumSkipReason } {
  if (!options) return { skip: 'not-configured' };
  if (!env.win || !env.win.document) return { skip: 'no-browser' };
  if (!telemetry || telemetry.enabled === false || !telemetry.faroEndpoint || !telemetry.browserToken) {
    return { skip: 'telemetry-disabled' };
  }
  if (options.respectDoNotTrack !== false && isDoNotTrack(env.nav, env.win)) return { skip: 'do-not-track' };
  const rawRatio = options.samplingRatio ?? telemetry.samplingRatio ?? 1;
  const ratio = Math.min(1, Math.max(0, Number(rawRatio)));
  if (!decideSampled(ratio, env.storage, env.random)) return { skip: 'not-sampled' };
  const resource = telemetry.resource || {};
  return {
    plan: {
      faroEndpoint: telemetry.faroEndpoint,
      errorsEndpoint: telemetry.errorsEndpoint,
      browserToken: telemetry.browserToken,
      samplingRatio: ratio,
      resource,
      propagateTo: options.propagateTo ?? (env.win.location?.origin ? [env.win.location.origin] : []),
      options,
      appName: options.appName || defaults.appName || 'web',
      environment: options.environment || defaults.environment || resource['deployment.environment'],
    },
  };
}

// ---------------------------------------------------------------- lifecycle

type FaroLoader = () => Promise<{ startFaro: (plan: RumPlan, initialView: string) => RumHandle }>;

const defaultLoader: FaroLoader = () => import('./rum-faro');

let starting: Promise<RumHandle | null> | null = null;
let active: RumHandle | null = null;
let pendingView: string | null = null;

async function loadTelemetry(options: PlatformRumOptions, win: any): Promise<PlatformTelemetryConfig | null> {
  if (options.telemetry !== undefined) return options.telemetry;
  if (!options.telemetryUrl || !win || typeof win.fetch !== 'function') return null;
  try {
    const res = await win.fetch(options.telemetryUrl, { credentials: 'omit' });
    if (!res.ok) return null;
    const body = await res.json();
    return (body && body.telemetry) || body || null;
  } catch {
    return null;
  }
}

/**
 * Start RUM once per page. Resolves to a handle, or null when RUM is not
 * configured, disabled by the platform, blocked by doNotTrack or sampled out
 * (in all of which cases Faro is never downloaded). Never throws.
 */
export function initRum(
  options: PlatformRumOptions | false | null | undefined,
  defaults: { appName?: string; environment?: string; apiBase?: string; token?: string } = {},
  deps: { load?: FaroLoader; env?: RumEnvironment } = {},
): Promise<RumHandle | null> {
  if (!options) return Promise.resolve(null);
  if (starting) return starting;
  const env = deps.env ?? browserEnv();
  starting = (async () => {
    try {
      const telemetry = await loadTelemetry(options, env.win);
      if (options.replay) void import('./rum-replay').then((m) => m.startReplay(options.replay, telemetry, { ...defaults, appVersion: options.appVersion, respectDoNotTrack: options.respectDoNotTrack })).catch(() => null);
      const decision = planRum(options, telemetry, defaults, env);
      if ('skip' in decision) return null;
      const mod = await (deps.load ?? defaultLoader)();
      const initialView = pendingView ?? normalizeRouteName(env.win.location?.pathname || '/');
      active = mod.startFaro(decision.plan, initialView);
      pendingView = null;
      return active;
    } catch {
      return null; // RUM must never break the host app
    }
  })();
  return starting;
}

/** Record a route/view change (new view id). Safe to call before or without RUM. */
export function setRumView(name: string): void {
  if (active) active.setView(name);
  else pendingView = name;
}

/** Forward a caught error to RUM (with stack; redacted before sending). No-op when RUM is off. */
export function reportRumError(error: unknown, context?: Record<string, string>): void {
  try {
    for (const h of addonHooks) h.onError?.(error);
    active?.pushError(error, context);
  } catch {
    /* never throw from error reporting */
  }
}

/** The running RUM handle, if any. */
export function getRum(): RumHandle | null {
  return active;
}

/** Stop RUM and restore patched globals (tests, logout, consent withdrawal). */
export function stopRum(): void {
  try {
    active?.stop();
  } finally {
    active = null;
    starting = null;
    pendingView = null;
  }
}

// ---------------------------------------------------------------- add-on hooks

/** Listener for lazily loaded RUM add-ons (session replay): caught errors and client spans. */
export interface RumAddonHook {
  onError?(error: unknown): void;
  onSpan?(span: ClientSpan): void;
}

const addonHooks: RumAddonHook[] = [];

/** Subscribe an add-on; returns the unsubscribe function. */
export function addRumHook(hook: RumAddonHook): () => void {
  addonHooks.push(hook);
  return () => {
    const i = addonHooks.indexOf(hook);
    if (i >= 0) addonHooks.splice(i, 1);
  };
}

/** Called by the RUM propagation layer for every finished client span. */
export function emitRumSpan(span: ClientSpan): void {
  for (const h of addonHooks) {
    try {
      h.onSpan?.(span);
    } catch {
      /* add-ons never break RUM */
    }
  }
}

let replayId: string | undefined;

/** Session replay id attached to error events (`replayId`), set while a replay records. */
export function setReplayIdForErrors(id: string | undefined): void {
  replayId = id;
}

/** The recording replay session id, if any (links errors to replays). */
export function getReplayId(): string | undefined {
  return replayId;
}

/**
 * Record the user's session-replay consent: `setConsent({ replay: true })` starts a
 * pending recording, `false` stops it at once. Stored on this device and sent to the
 * platform. Loads the small replay controller lazily (never rrweb by itself).
 */
export function setConsent(consent: { replay?: boolean }): Promise<void> {
  return import('./rum-replay').then((m) => m.setConsent(consent)).catch(() => undefined);
}

/** Stop session replay (logout, tests). Already uploaded chunks stay on the server. */
export function stopReplay(): Promise<void> {
  return import('./rum-replay').then((m) => m.stopReplay()).catch(() => undefined);
}
