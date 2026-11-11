/**
 * Click and scroll-depth heatmap capture for the Platform browser SDKs.
 *
 * Loaded only through `import('./rum-heatmap')` from rum.ts when the app sets
 * `rum.heatmaps` and RUM itself is running (configured, not doNotTrack, sampled in),
 * so apps that do not opt in never download this code.
 *
 * What is sent (batched, `POST /api/sdk/heatmap/events`):
 * - click: page (normalised like RUM view names), viewport bucket, x/y as fractions of
 *   the document width/height, and a short CSS selector (tag/id/class, never text/values);
 * - scroll: the maximum scroll depth (percent of the document) reached in one page view,
 *   sent once when the view ends (route change, tab hidden, page unload).
 * No user id, session id, coordinates in pixels or element text is sent; an optional
 * `subjectId` is used by the API only to resolve #47 consent and is never stored.
 * Do-Not-Track / Global Privacy Control always disables capture, the optional `consent`
 * callback gates start and every send, and a `consent: false` reply stops capture.
 *
 * NOTE: shared verbatim between sdk-react and sdk-angular.
 */
import type { PlatformTelemetryConfig, RumHandle, RumPlan } from './rum';

// ---------------------------------------------------------------- same rules as rum.ts
// Duplicated (not imported) so this lazy chunk does not keep these helpers alive in the
// shared rum.ts chunk of apps that never enable heatmaps. Tests assert they stay identical.

/** DNT or Global Privacy Control (same as rum.ts isDoNotTrack). */
export function isDoNotTrack(nav: any, win?: any): boolean {
  const yes = (v: unknown) => v === '1' || v === 'yes' || v === 1 || v === true;
  return !!(
    (nav && (yes(nav.doNotTrack) || yes(nav.msDoNotTrack) || nav.globalPrivacyControl === true)) ||
    (win && yes(win.doNotTrack))
  );
}

const DYNAMIC_SEGMENT = [/^\d+$/,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, /^[0-9a-f]{16,}$/i, /^[A-Za-z0-9_-]{24,}$/];

/** Page key like RUM view names (same as rum.ts normalizeRouteName): /users/42 -> /users/:id. */
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

export interface PlatformHeatmapOptions {
  /** Ingest URL. Default: `telemetry.heatmapsEndpoint`. */
  endpoint?: string;
  /** Bearer token: a browser-kind SDK token or the RUM web ingest token. Default: `telemetry.heatmapsToken` or `telemetry.browserToken`. */
  token?: string;
  /** Session sampling ratio 0..1 (applied on top of RUM sampling). Default 1. */
  samplingRatio?: number;
  /** Analytics consent gate, checked before starting and before every send. */
  consent?: () => boolean | Promise<boolean>;
  /** Pseudonymous subject id used by the API only to look up #47 consent (never stored). */
  subjectId?: string | (() => string | undefined | null);
  /** Flush interval in ms (default 5000). */
  flushIntervalMs?: number;
  /** Max events per request (default 100). */
  maxBatch?: number;
}

export type ViewportBucket = 'mobile' | 'tablet' | 'desktop';

export interface HeatmapClick {
  type: 'click';
  page: string;
  viewport: ViewportBucket;
  x: number;
  y: number;
  selector?: string;
}

export interface HeatmapScroll {
  type: 'scroll';
  page: string;
  viewport: ViewportBucket;
  depth: number;
}

export type HeatmapEvent = HeatmapClick | HeatmapScroll;

// ---------------------------------------------------------------- pure helpers

/** Same breakpoints as the API: < 768 mobile, < 1024 tablet, else desktop. */
export function viewportBucket(width: number): ViewportBucket {
  if (!(width > 0) || width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => (n > 1 ? 1 : n > 0 ? n : 0);

/** Click position as fractions of the document size (0..1, 4 decimals). */
export function normalizeClick(pageX: number, pageY: number, docWidth: number, docHeight: number): { x: number; y: number } | null {
  if (!(docWidth > 0) || !(docHeight > 0) || !Number.isFinite(pageX) || !Number.isFinite(pageY)) return null;
  return { x: round4(clamp01(pageX / docWidth)), y: round4(clamp01(pageY / docHeight)) };
}

/** Percent of the document seen: bottom of the viewport / document height (0..100). */
export function scrollDepth(scrollY: number, viewportHeight: number, docHeight: number): number {
  if (!(docHeight > 0)) return 100;
  const seen = (Math.max(0, scrollY || 0) + Math.max(0, viewportHeight || 0)) / docHeight;
  return Math.round(clamp01(seen) * 1000) / 10;
}

/** Document size (the largest of the usual measurements). */
export function documentSize(doc: any, win: any): { width: number; height: number } {
  const el = doc?.documentElement || {};
  const body = doc?.body || {};
  return {
    width: Math.max(el.scrollWidth || 0, body.scrollWidth || 0, el.clientWidth || 0, win?.innerWidth || 0),
    height: Math.max(el.scrollHeight || 0, body.scrollHeight || 0, el.clientHeight || 0, win?.innerHeight || 0),
  };
}

const ACTIONABLE = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[data-rum-name]';
const NAME_OK = /^[A-Za-z][\w-]{0,63}$/;
const CLASS_OK = /^[A-Za-z_-][\w-]{0,40}$/;

/** Short CSS selector for the clicked (actionable) element: tag, id, classes, data-rum-name. Never text or values. */
export function heatmapSelector(target: any, maxDepth = 4): string | undefined {
  let el = target && target.nodeType === 1 ? target : target?.parentElement;
  if (!el) return undefined;
  el = el.closest?.(ACTIONABLE) || el;
  const parts: string[] = [];
  for (let depth = 0; el && el.nodeType === 1 && depth < maxDepth; depth++) {
    const tag = String(el.tagName || '').toLowerCase();
    if (!tag || tag === 'html' || tag === 'body') break;
    const named = el.getAttribute?.('data-rum-name');
    if (named && NAME_OK.test(named)) {
      parts.unshift(`${tag}[data-rum-name="${named}"]`);
      break;
    }
    if (el.id && NAME_OK.test(el.id)) {
      parts.unshift(`${tag}#${el.id}`);
      break;
    }
    const classes = String(typeof el.className === 'string' ? el.className : '')
      .split(/\s+/)
      .filter((c) => CLASS_OK.test(c))
      .slice(0, 2);
    parts.unshift(classes.length ? `${tag}.${classes.join('.')}` : tag);
    el = el.parentElement;
  }
  const s = parts.join(' > ');
  return s && s.length <= 256 ? s : undefined;
}

const SAMPLE_KEY = 'platform.heatmap.sampled';

/** Session-sticky sampling decision for heatmaps. */
export function heatmapSampled(ratio: number, storage?: Pick<Storage, 'getItem' | 'setItem'> | null, random: () => number = Math.random): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  try {
    const prev = storage?.getItem(SAMPLE_KEY);
    if (prev === '1' || prev === '0') return prev === '1';
  } catch {
    /* storage blocked */
  }
  const yes = random() < ratio;
  try {
    storage?.setItem(SAMPLE_KEY, yes ? '1' : '0');
  } catch {
    /* storage blocked */
  }
  return yes;
}

/** Retry delay: `Retry-After` when given, else exponential backoff (1 s .. 60 s) with jitter. */
export function backoffMs(failures: number, retryAfter: string | null | undefined, random: () => number = Math.random): number {
  const secs = Number(retryAfter);
  if (retryAfter && Number.isFinite(secs) && secs >= 0) return Math.min(300_000, secs * 1000);
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, failures - 1));
  return Math.round(base / 2 + random() * (base / 2));
}

// ---------------------------------------------------------------- collector

export interface HeatmapEnv {
  win?: any;
  doc?: any;
  nav?: any;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  fetchImpl?: (url: string, init: any) => Promise<{ status: number; headers?: { get(n: string): string | null }; json?: () => Promise<any> }>;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface HeatmapCollector {
  /** Send queued events now (resolves when the request settles). */
  flush(unloading?: boolean): Promise<void>;
  /** Queued, unsent events (tests / diagnostics). */
  pending(): HeatmapEvent[];
  stop(): void;
  readonly stopped: boolean;
}

const MAX_QUEUE = 500;

/** Resolve options against the telemetry block; null when heatmaps cannot run. */
export function resolveHeatmapConfig(
  opts: boolean | PlatformHeatmapOptions | undefined,
  telemetry: PlatformTelemetryConfig | null | undefined,
  plan?: Pick<RumPlan, 'browserToken'>,
): (PlatformHeatmapOptions & { endpoint: string; token: string }) | null {
  if (!opts) return null;
  const o: PlatformHeatmapOptions = opts === true ? {} : opts;
  const endpoint = o.endpoint || telemetry?.heatmapsEndpoint || '';
  const token = o.token || telemetry?.heatmapsToken || plan?.browserToken || telemetry?.browserToken || '';
  if (!endpoint || !token) return null;
  return { ...o, endpoint, token };
}

/**
 * Start capturing. Returns null (and installs nothing) when DNT/GPC is set, the browser
 * is missing, or the session is sampled out. Never throws.
 */
export function createHeatmapCollector(
  config: PlatformHeatmapOptions & { endpoint: string; token: string },
  env: HeatmapEnv = {},
): HeatmapCollector | null {
  const win = env.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = env.doc ?? win?.document;
  const nav = env.nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!win || !doc) return null;
  if (isDoNotTrack(nav, win)) return null;
  let storage = env.storage;
  if (storage === undefined) {
    try {
      storage = win.sessionStorage;
    } catch {
      storage = null;
    }
  }
  const random = env.random ?? Math.random;
  if (!heatmapSampled(config.samplingRatio ?? 1, storage, random)) return null;

  const fetchImpl = env.fetchImpl ?? (typeof win.fetch === 'function' ? win.fetch.bind(win) : null);
  if (!fetchImpl) return null;
  const now = env.now ?? (() => Date.now());
  const setTimer = env.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = env.clearTimer ?? ((t: unknown) => clearTimeout(t as any));
  const maxBatch = Math.max(1, Math.min(500, config.maxBatch ?? 100));
  const interval = Math.max(1000, config.flushIntervalMs ?? 5000);

  let queue: HeatmapEvent[] = [];
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let failures = 0;
  let blockedUntil = 0;
  const cleanups: Array<() => void> = [];

  const currentPage = () => normalizeRouteName(win.location?.pathname || '/');
  const currentViewport = () => viewportBucket(win.innerWidth || doc.documentElement?.clientWidth || 0);
  const measureDepth = () => scrollDepth(win.scrollY ?? win.pageYOffset ?? 0, win.innerHeight || 0, documentSize(doc, win).height);

  // One page view: max depth seen, emitted once when the view ends.
  let view = { page: currentPage(), viewport: currentViewport(), depth: measureDepth(), sent: false };

  const push = (e: HeatmapEvent) => {
    if (stopped) return;
    queue.push(e);
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    if (queue.length >= maxBatch) void flush();
  };
  const endView = () => {
    if (view.sent) return;
    view.sent = true;
    push({ type: 'scroll', page: view.page, viewport: view.viewport, depth: view.depth });
  };
  /** Start a new view when the SPA route changed (checked on every event and tick). */
  const syncView = () => {
    const page = currentPage();
    if (page === view.page) return;
    endView();
    view = { page, viewport: currentViewport(), depth: measureDepth(), sent: false };
  };

  const resolveSubject = () => {
    try {
      const s = typeof config.subjectId === 'function' ? config.subjectId() : config.subjectId;
      return s ? String(s).slice(0, 128) : undefined;
    } catch {
      return undefined;
    }
  };
  const consentOk = async () => {
    if (!config.consent) return true;
    try {
      return !!(await config.consent());
    } catch {
      return false;
    }
  };

  async function send(unloading: boolean): Promise<void> {
    if (stopped || !queue.length || now() < blockedUntil) return;
    if (!(await consentOk())) {
      queue = []; // no consent: nothing captured so far may leave the browser
      return;
    }
    const batch = queue.slice(0, maxBatch);
    const subjectId = resolveSubject();
    const body = JSON.stringify(subjectId ? { subjectId, events: batch } : { events: batch });
    let status = 0;
    let retryAfter: string | null = null;
    let reply: any = null;
    try {
      const res = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
        body,
        credentials: 'omit',
        mode: 'cors',
        keepalive: unloading && body.length < 60_000,
      });
      status = res.status;
      retryAfter = res.headers?.get?.('Retry-After') ?? null;
      if (status === 202 && typeof res.json === 'function') reply = await res.json().catch(() => null);
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      queue = queue.slice(batch.length);
      failures = 0;
      if (reply && reply.consent === false) collector.stop(); // #47: analytics not allowed for this subject
      return;
    }
    if (status === 401 || status === 403) {
      collector.stop(); // bad / disallowed token: stop for this page load
      return;
    }
    if (status === 400 || status === 413) {
      queue = queue.slice(batch.length); // malformed: drop, never retry
      return;
    }
    failures++; // 0 (network), 429, 5xx: keep the events, back off
    blockedUntil = now() + backoffMs(failures, retryAfter, random);
  }

  function flush(unloading = false): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = send(unloading).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const onClick = (ev: any) => {
    try {
      syncView();
      const size = documentSize(doc, win);
      const pageX = ev.pageX ?? (ev.clientX ?? 0) + (win.scrollX ?? 0);
      const pageY = ev.pageY ?? (ev.clientY ?? 0) + (win.scrollY ?? 0);
      const pos = normalizeClick(pageX, pageY, size.width, size.height);
      if (!pos) return;
      const e: HeatmapClick = { type: 'click', page: view.page, viewport: currentViewport(), x: pos.x, y: pos.y };
      const sel = heatmapSelector(ev.target);
      if (sel) e.selector = sel;
      push(e);
    } catch {
      /* never break the host app */
    }
  };
  let lastScroll = 0;
  const onScroll = () => {
    const t = now();
    if (t - lastScroll < 200) return; // layout reads are throttled
    lastScroll = t;
    try {
      syncView();
      const d = measureDepth();
      if (d > view.depth) view.depth = d;
    } catch {
      /* ignore */
    }
  };
  /** Tab hidden or page unloading: end the view (scroll depth) and flush with keepalive. */
  const onLeave = () => {
    onScroll();
    endView();
    void flush(true);
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') onLeave();
  };

  const listen = (target: any, type: string, fn: any, opts: any) => {
    target?.addEventListener?.(type, fn, opts);
    cleanups.push(() => target?.removeEventListener?.(type, fn, opts));
  };
  listen(doc, 'click', onClick, { capture: true, passive: true });
  listen(win, 'scroll', onScroll, { passive: true });
  listen(win, 'popstate', syncView, false);
  listen(doc, 'visibilitychange', onVisibility, false);
  listen(win, 'pagehide', onLeave, false);

  let timer: unknown = null;
  const tick = () => {
    timer = null;
    if (stopped) return;
    try {
      syncView();
    } catch {
      /* ignore */
    }
    void flush().finally(() => {
      if (!stopped) timer = setTimer(tick, interval);
    });
  };
  timer = setTimer(tick, interval);
  cleanups.push(() => {
    if (timer !== null) clearTimer(timer);
  });

  const collector: HeatmapCollector = {
    flush,
    pending: () => queue.slice(),
    stop() {
      if (stopped) return;
      stopped = true;
      queue = [];
      cleanups.splice(0).forEach((fn) => fn());
    },
    get stopped() {
      return stopped;
    },
  };
  return collector;
}

/**
 * Entry point used by rum.ts (`import('./rum-heatmap')`). Waits for the optional consent
 * gate, starts the collector and chains its stop into the RUM handle's stop().
 */
export async function startHeatmaps(
  plan: RumPlan,
  telemetry: PlatformTelemetryConfig | null | undefined,
  env: { win?: any; nav?: any; storage?: Pick<Storage, 'getItem' | 'setItem'> | null; random?: () => number },
  handle: RumHandle | null,
): Promise<HeatmapCollector | null> {
  try {
    const config = resolveHeatmapConfig(plan.options.heatmaps, telemetry, plan);
    if (!config) return null;
    if (config.consent && !(await Promise.resolve().then(config.consent).catch(() => false))) return null;
    const collector = createHeatmapCollector(config, { win: env.win, nav: env.nav, storage: env.storage, random: env.random });
    if (collector && handle) {
      const prev = handle.stop.bind(handle);
      handle.stop = () => {
        collector.stop();
        prev();
      };
    }
    return collector;
  } catch {
    return null;
  }
}
